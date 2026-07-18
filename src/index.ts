import * as core from '@actions/core'
import { spawnSync, execFileSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Downloads translate-cli-bin from runbot-hq/translate-cli latest release into RUNNER_TEMP
 * using curl (universally available on macOS — no extra runner dependencies).
 *
 * execFileSync is used deliberately — args are a plain array passed directly
 * to the OS, no shell involved, no injection risk from the URL constant.
 * Do NOT refactor to execSync with a shell string.
 *
 * The binary is written to RUNNER_TEMP (not the workspace) so it is:
 *   - Cleaned up automatically after the job (on GitHub-hosted runners)
 *   - Not committed or staged into the caller's repo checkout
 *   - Shared across steps in the same job if needed
 * RUNNER_TEMP is per-job on GitHub-hosted runners and is cleaned up
 * automatically after the job completes. On self-hosted runners RUNNER_TEMP
 * persistence is operator-controlled — it is NOT guaranteed to be cleaned
 * between jobs unless the runner is configured with --ephemeral or the
 * operator explicitly cleans it. On a persistent self-hosted RUNNER_TEMP, a
 * stale binary from a prior job run will be silently reused by the
 * fs.existsSync skip-download guard in run(). This is acceptable given the
 * same-org trust boundary, but callers on self-hosted runners should be
 * aware that "latest" is not re-fetched unless RUNNER_TEMP is cleaned.
 *
 * releases/latest tradeoff: the URL resolves to whatever is currently the
 * latest release at runbot-hq/translate-cli — no SHA pinning, no checksum
 * verification. This is a conscious architectural tradeoff accepted because:
 *   - runbot-hq controls both this repo and translate-cli (same org, same trust boundary)
 *   - curl --fail will catch 404 / HTTP errors and exit non-zero
 *   - The self-hosted runner has no internet exposure beyond GitHub
 *
 * --retry 3 --retry-delay 2: retries up to 3 times on transient network errors
 * (TCP reset, CDN hiccup on the GitHub releases redirect chain). curl --fail
 * still exits non-zero on HTTP 4xx/5xx — --retry does not retry those.
 * If all retries fail, execFileSync throws and the partial file (if any) is
 * cleaned up before propagating the error (see try/catch below).
 *
 * Partial-file and zero-byte cleanup: if curl fails after writing partial
 * bytes, the try/catch calls fs.unlinkSync(dest) before re-throwing. After a
 * successful curl exit, a size check guards against the narrow window where
 * curl exits 0 with a zero-byte output (e.g. CDN returns 200 with empty body
 * before --fail triggers). A zero-byte file passes existsSync + chmodSync +
 * accessSync(X_OK) but causes ENOEXEC at spawnSync. The size check throws and
 * unlinks before that can happen.
 * Do NOT remove either the try/catch cleanup or the size check.
 */
function downloadTranslateCli(dest: string): void {
  core.info('[translate] Downloading translate-cli-bin from runbot-hq/translate-cli latest release...')
  try {
    execFileSync('curl', [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--retry', '3',
      '--retry-delay', '2',
      'https://github.com/runbot-hq/translate-cli/releases/latest/download/translate-cli-bin',
      '--output', dest,
    ])
  } catch (e) {
    // Clean up any partial file curl may have written before throwing.
    // Without this, a re-run of the same job step finds fs.existsSync(dest)
    // true, skips the download, then fails at fs.accessSync(X_OK) with a
    // confusing error instead of retrying.
    try { fs.unlinkSync(dest) } catch { /* ignore — file may not exist */ }
    throw e
  }

  // Guard against zero-byte output. curl can exit 0 with an empty file in the
  // narrow window where the CDN returns HTTP 200 but delivers an empty body
  // before --fail triggers. A zero-byte file passes chmodSync and accessSync
  // (X_OK) but causes ENOEXEC (or equivalent) at spawnSync, producing a
  // confusing error. Catch it here and fail loudly with a clear message.
  // Do NOT remove this check.
  const stat = fs.statSync(dest)
  if (stat.size === 0) {
    try { fs.unlinkSync(dest) } catch { /* ignore */ }
    throw new Error('curl downloaded a zero-byte translate-cli-bin — the release asset may be missing or the CDN returned an empty response')
  }

  fs.chmodSync(dest, 0o755)
  core.info(`[translate] Downloaded translate-cli-bin to ${dest}`)
}

/**
 * Calls translate-cli-bin via spawnSync with an explicit argv array.
 *
 * spawnSync is used instead of execSync deliberately:
 * - Args pass directly to the OS — no shell metacharacter expansion.
 * - User-supplied values (language codes, file paths) cannot escape as shell
 *   injection via spaces, semicolons, backticks, $(), etc.
 * - The binary name is hardcoded to `translate-cli-bin` (not `translate-cli`)
 *   to avoid future name collision with a source directory of the same name.
 */
function translateCli(bin: string, args: string[]): { stdout: string; stderr: string } {
  if (core.isDebug()) {
    core.debug(`[translate] spawnSync: ${bin} ${args.map(a => JSON.stringify(a)).join(' ')}`)
  }

  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    // 5-minute timeout per attempt. With one retry this means up to ~10 min wall time
    // (5m attempt 1 + 10s delay + 5m attempt 2) for very large .xcstrings files.
    // This is intentional: large repos with many locales legitimately take several minutes.
    // Callers with large jobs should be aware of this ceiling.
    // A timeout surfaces as result.error (ETIMEDOUT), which is non-fatal and will be retried.
    timeout: 300_000,
    maxBuffer: 10 * 1024 * 1024,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`translate-cli exited ${result.status}: ${result.stderr?.trim()}`)
  }

  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Returns true if the error is fatal and a retry will not help.
 *
 * Fatal conditions (no point retrying):
 * - Language pack not installed — user must download via System Settings
 * - Unsupported language pair — Apple Translation does not support this pair at all
 * - macOS version too old — runner needs upgrading, not retrying
 * - Permission / MDM policy denied — infrastructure issue, not transient
 *
 * Non-fatal (retry may help): model cold-start, temporary framework crash, I/O blip.
 *
 * Substring matching is intentional — Apple's error messages are not versioned or
 * guaranteed stable, so we match on the most stable sub-phrase rather than the full string.
 * Verified match table (lower-cased actual message → which check fires):
 *   'translation framework requires macos 26+' → 'requires macos 26'  ✔
 *   'language pack not installed for ...'      → 'language pack not installed'  ✔
 *   'unsupported language pair: xx-YY'         → 'unsupported language pair'  ✔
 *
 * COUPLING NOTE — two matches are owned by THIS codebase, not by Apple:
 *   'unsupported language pair' → TranslationEngineError.unsupportedPair.description (TranslationEngine.swift)
 *   'requires macos 26'         → TranslationEngineError.requiresmacOS26.description  (TranslationEngine.swift)
 * If either Swift description string changes, the corresponding match here silently stops
 * firing: 'unsupported language pair' would be retried instead of marked fatal; 'requires
 * macos 26' would fall through to a retry rather than immediately failing. Always update
 * both files together. The other matches ('language pack not installed', 'eacces', etc.)
 * come from Apple / the OS and are NOT under our control.
 *   permission/sandbox errors                  → 'eacces' / 'not authorized'  ✔
 *
 * macOS 26.0–26.3 caveat: on those OS versions, TranslationEngine skips the
 * LanguageAvailability preflight check (API requires 26.4). If a language pack is missing,
 * Apple's framework throws an opaque error whose message is NOT controlled by us and may
 * NOT match 'language pack not installed' below. In that case isFatalTranslateError returns
 * false and the error is retried once — harmless but inefficient. If you observe spurious
 * retries on 26.0–26.3 runners for missing packs, identify the opaque error substring and
 * add it here. See also: TranslationEngine.swift macOS 26.0–26.3 fallback branch comment.
 */
function isFatalTranslateError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  return (
    msg.includes('language pack not installed') ||
    msg.includes('unsupported language pair') ||
    msg.includes('requires macos 26') ||
    // 'translation framework' match intentionally removed: it was over-broad and matched
    // transient crash messages that should be retried. The two cases it was meant to catch
    // (requiresmacOS26, languagePackNotInstalled) are already covered by the lines above.
    msg.includes('eacces') ||
    msg.includes('not authorized') ||
    msg.includes('mdm policy')
  )
}

/**
 * Parses translate-cli stdout for `key=value` output lines.
 *
 * translate-cli emits exactly three lines to stdout (and nothing else):
 *   keys_translated=42
 *   languages_completed=de,fr,ja
 *   languages_failed=zh-Hans
 *
 * Parsing is done here rather than in the shell step so the action can set
 * typed `core.setOutput()` values and emit structured step-summary content
 * without a jq dependency on the runner.
 *
 * `val.split('=')` with `rest.join('=')` handles the (unlikely) case where
 * a value itself contains `=` characters.
 */
function parseOutput(stdout: string): {
  keysTranslated: number
  languagesCompleted: string[]
  languagesFailed: string[]
} {
  const lines = stdout.split('\n')
  let keysTranslated = 0
  let languagesCompleted: string[] = []
  let languagesFailed: string[] = []

  for (const line of lines) {
    const [key, ...rest] = line.split('=')
    const val = rest.join('=').trim()
    switch (key?.trim()) {
      case 'keys_translated':
        // parseInt(val, 10) || 0 — intentional NaN coercion, not a silent data-loss bug.
        // parseInt returns NaN only for fully non-numeric strings (e.g. "abc").
        // parseInt("0", 10) returns 0, so `0 || 0` is still 0 — no false zero.
        // Note: parseInt("1text", 10) returns 1 (leading digits), not NaN — but translate-cli
        // is the only producer of this line and always emits a clean integer. The || 0
        // guard exists solely to prevent a NaN from propagating to setOutput/summary on a
        // hypothetical future malformed line. It is not masking any real data loss.
        keysTranslated = parseInt(val, 10) || 0
        break
      case 'languages_completed':
        languagesCompleted = val ? val.split(',').map(s => s.trim()).filter(Boolean) : []
        break
      case 'languages_failed':
        languagesFailed = val ? val.split(',').map(s => s.trim()).filter(Boolean) : []
        break
    }
  }

  return { keysTranslated, languagesCompleted, languagesFailed }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  try {
    // Resolve debug early — used both for core.debug() gating and --debug flag passthrough.
    // NOTE: core.isDebug() reads RUNNER_DEBUG (set by the runner at process startup).
    // Setting ACTIONS_STEP_DEBUG at runtime in the same process has no effect on
    // core.isDebug() — the runner does not re-read it after startup. The debug input
    // therefore controls CLI verbosity via --debug (passed to translate-cli-bin below),
    // not via ACTIONS_STEP_DEBUG. Do NOT reintroduce the ACTIONS_STEP_DEBUG assignment.
    const debugInput = core.getInput('debug') === 'true'

    // translate-cli-bin is downloaded at runtime from runbot-hq/translate-cli latest release
    // via curl into RUNNER_TEMP. curl ships with macOS as part of the OS —
    // no extra runner dependencies. RUNNER_TEMP is cleaned up after the job on
    // GitHub-hosted runners. See downloadTranslateCli() JSDoc for the full RUNNER_TEMP
    // persistence caveat on self-hosted runners and the releases/latest tradeoff.
    const translateBin = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'translate-cli-bin')

    // Skip download if binary is already present in RUNNER_TEMP. On GitHub-hosted
    // runners RUNNER_TEMP is per-job so this only fires for multi-step sharing
    // within the same job. On self-hosted runners with a persistent RUNNER_TEMP,
    // this may reuse a binary from a prior job run — see downloadTranslateCli() JSDoc.
    if (!fs.existsSync(translateBin)) {
      downloadTranslateCli(translateBin)
    } else {
      core.info(`[translate] translate-cli-bin already present at ${translateBin}, skipping download`)
    }

    // Check executable bit explicitly: a missing `+x` bit after download is unexpected
    // (downloadTranslateCli calls chmodSync) but worth a clear error rather than EACCES.
    try {
      fs.accessSync(translateBin, fs.constants.X_OK)
    } catch {
      throw new Error(
        `translate-cli-bin at ${translateBin} is not executable. This is unexpected after download — please file a bug.`
      )
    }

    // Resolve inputs
    const input = core.getInput('input').trim()
    const output = core.getInput('output').trim()
    const languages = core.getInput('languages').trim()
    const config = core.getInput('config').trim()
    const manifest = core.getInput('manifest').trim()
    // source_language intentionally defaults to '' (empty string) — not 'en'.
    // When empty, --source-language is NOT passed to translate-cli, so the CLI
    // reads sourceLanguage directly from the .xcstrings file. This is correct for
    // any .xcstrings file regardless of its declared source language.
    // Only set source_language explicitly when:
    //   a) translating .strings files (no embedded source language)
    //   b) the .xcstrings sourceLanguage field is wrong or absent
    // Passing 'en' when the .xcstrings declares a different source language causes
    // DiffExtractor to look up source values under 'en' and find nothing — 0 keys translated.
    const sourceLanguage = core.getInput('source_language').trim()
    const quality = core.getInput('quality').trim() || 'high'
    const format = core.getInput('format').trim() || 'xcstrings'

    if (!input) {
      throw new Error('Input `input` is required (path to source .xcstrings / .strings / .md file).')
    }

    // `languages` and `config` are mutually exclusive alternatives — at least one is required.
    // `languages` takes precedence if both are provided (handled in translate-cli itself).
    if (!languages && !config) {
      throw new Error('Either `languages` or `config` must be provided.')
    }

    if (!fs.existsSync(input)) {
      throw new Error(`Input file not found: ${input}`)
    }

    // Validate quality — guard here so the error message is clear rather than surfacing
    // as a cryptic translate-cli exit code.
    if (quality !== 'fast' && quality !== 'high') {
      throw new Error(`Invalid quality value: "${quality}". Must be "fast" or "high".`)
    }

    // Validate format — same rationale as quality validation above.
    if (!['xcstrings', 'strings', 'markdown'].includes(format)) {
      throw new Error(`Invalid format value: "${format}". Must be "xcstrings", "strings", or "markdown".`)
    }

    // Resolve output path.
    // - xcstrings / markdown: output is a file path; default = same as input (in-place update)
    // - strings: output is a directory; lproj subdirs are created by translate-cli;
    //   default = dirname(input)
    const resolvedOutput = output ||
      (format === 'strings'
        ? path.dirname(input)
        : input)

    const args: string[] = [
      '--input', input,
      '--output', resolvedOutput,
      '--quality', quality,
      '--format', format,
    ]

    // Only pass --source-language when explicitly set by the caller.
    // When omitted, translate-cli reads sourceLanguage from the .xcstrings file directly.
    // Passing 'en' unconditionally would silently override a non-English sourceLanguage
    // in the .xcstrings file, causing DiffExtractor to find 0 keys to translate.
    if (sourceLanguage) {
      args.push('--source-language', sourceLanguage)
    }

    if (languages) {
      args.push('--languages', languages)
    }
    if (config) {
      // `config` is intentionally NOT existence-checked before passing to translate-cli.
      // This is NOT a missing guard — it is a deliberate trade-off:
      //   Adding fs.existsSync(config) here would break workflows where the config file is
      //   generated by an earlier step in the same job (e.g. written by a matrix step or
      //   a prior action). At the point this action runs, the file exists at runtime even
      //   though it wasn't present at checkout. A pre-flight existsSync would race against
      //   that and produce a confusing false-negative.
      // If config is genuinely absent at runtime, translate-cli exits non-zero with a clear
      // error from LocalizationConfigLoader, which surfaces via spawnSync's non-zero status
      // and is re-thrown by translateCli() above. The error message is slightly less targeted
      // than a pre-check, but the failure is still loud and actionable.
      args.push('--config', config)
    }
    if (manifest) {
      args.push('--manifest', manifest)
    }

    // Pass --debug to the CLI when the debug input is 'true'.
    // This drives verbose stderr logging in translate-cli directly.
    // Do NOT use ACTIONS_STEP_DEBUG for this — setting it at runtime has no effect
    // on core.isDebug() because the runner reads RUNNER_DEBUG at process startup.
    if (debugInput) {
      args.push('--debug')
    }

    core.info(`[translate] Running translate-cli for languages: ${languages || config || '(from config)'}`)
    core.info(`[translate] Input: ${input} → Output: ${resolvedOutput}`)

    // Call translate-cli with one retry on non-fatal errors.
    // The retry handles Apple Translation model cold-start: on the first invocation after
    // a runner boot, the framework occasionally needs a few seconds to initialise and
    // returns a transient error. A 10-second delay before retry is enough in practice.
    let stdout = ''
    try {
      const r = translateCli(translateBin, args)
      stdout = r.stdout
      if (r.stderr) core.debug(`[translate] stderr: ${r.stderr}`)
    } catch (e) {
      core.debug(`[translate] Attempt 1 error: ${String(e)}`)
      if (isFatalTranslateError(e)) throw e  // don't retry fatal errors
      core.info('[translate] Attempt 1 failed — retrying in 10s...')
      await new Promise(r => setTimeout(r, 10_000))
      try {
        const r = translateCli(translateBin, args)
        stdout = r.stdout
        if (r.stderr) core.debug(`[translate] stderr: ${r.stderr}`)
      } catch (e2) {
        throw new Error(
          `[translate] Attempt 2 failed (binary: ${translateBin}): ${String(e2)}`
        )
      }
    }

    if (!stdout.trim()) {
      // Empty stdout means translate-cli exited 0 but produced no output at all.
      // This should never happen: translate-cli always emits the three key=value lines
      // even when keys_translated=0 (genuine nothing-to-do). An empty stdout therefore
      // indicates a silent binary crash or unexpected early exit — not a legitimate no-op.
      // We fail the step explicitly here so callers don't see a spurious green run with
      // zero outputs and no indication anything went wrong.
      // Two-line pattern: setFailed + return. Both lines are required — neither alone is enough.
      //   core.setFailed() marks the step conclusion as failed but does NOT throw or stop
      //   execution — code continues running after the call. Without the `return`, the
      //   setOutput / summary / setFailed-on-all-failed block below would all execute on
      //   bad (empty) parsed data, producing misleading step outputs.
      //   The explicit `return` is what actually halts run(). Do not remove either line.
      core.setFailed('[translate] translate-cli produced no stdout — binary may have crashed silently. Check runner logs for stderr output.')
      return
    }

    const { keysTranslated, languagesCompleted, languagesFailed } = parseOutput(stdout)

    core.info(`[translate] Keys translated: ${keysTranslated}`)
    core.info(`[translate] Languages completed: ${languagesCompleted.join(', ') || '(none)'}`)  
    if (languagesFailed.length > 0) {
      core.warning(`[translate] Languages failed: ${languagesFailed.join(', ')}`)
    }

    // Output contract — read this before using these values in workflow steps:
    //
    // keys_translated:
    //   xcstrings/strings: count of source keys translated (0 = nothing changed, safe to skip commit).
    //   markdown:          1 if ≥1 locale completed, 0 if ALL locales failed.
    //                      It is NOT a key count. Do NOT gate a commit on `keys_translated > 0`
    //                      in markdown mode — gate on `languages_completed != ''` instead.
    //
    // languages_completed:
    //   Comma-separated locales that produced output this run.
    //   In markdown mode this is the ONLY reliable success signal.
    //   NOTE: a locale appearing here means the CLI exited without throwing for that locale.
    //   It does NOT guarantee every paragraph was translated — the Apple framework may
    //   silently drop individual paragraphs (nil clientIdentifier response). When that
    //   happens the original paragraph is kept in the output and the locale still appears
    //   as completed. This is a known Apple framework behaviour, not a bug in the action.
    //
    // languages_failed:
    //   Comma-separated locales that threw a fatal or retriable error.
    //   Empty string (not absent) when no locales failed.
    core.setOutput('keys_translated', String(keysTranslated))
    core.setOutput('languages_completed', languagesCompleted.join(','))
    core.setOutput('languages_failed', languagesFailed.join(','))

    // addRaw() with `input`, `languages`, `quality` — not an XSS/injection risk here.
    // These values originate from the workflow YAML in the caller's own repository
    // (the repo author controls them), not from untrusted external content such as
    // PR titles, issue bodies, or user comments. The GitHub Actions step summary is
    // rendered only in the Actions UI for authenticated repo members — it is not
    // a public-facing surface. addEscaped() would be cleaner hygiene but this is
    // explicitly NOT a security boundary. If these fields are ever populated from
    // PR/issue/comment content (e.g. a language code extracted from a PR body),
    // switch to addEscaped() or sanitise before this call.
    await core.summary
      .addHeading('🌐 Translation Complete')
      .addRaw(`**Input:** \`${input}\`\n`)
      .addRaw(`**Languages:** ${languages || '(from config)'}\n`)
      .addRaw(`**Quality:** ${quality}\n`)
      // keys_translated is a pre-flight diff count — it is non-zero even when all locales failed
      // and nothing was written. Label it "Keys pending" on a total-failure run so the summary
      // doesn't show "Keys translated: 42" alongside "Completed: (none)", which is misleading.
      // In markdown mode it is 0 or 1 (the document is one unit); label it "(document)" there.
      .addRaw(`**${languagesCompleted.length === 0 ? 'Keys pending' : 'Keys translated'}:** ${keysTranslated}${format === 'markdown' ? ' (document)' : ''}\n`)
      .addRaw(`**Completed:** ${languagesCompleted.join(', ') || '(none)'}\n`)
      .addRaw(languagesFailed.length > 0 ? `**Failed:** ${languagesFailed.join(', ')}\n` : '')
      .addRaw(`**Runner:** ${process.env.RUNNER_NAME ?? 'unknown'}\n`)
      .write()

    // Step failure policy: fail hard only when EVERY language failed (nothing was written).
    //
    // Partial failure (some locales failed, others completed) is intentionally NOT a step
    // failure. Reasons:
    //   1. The completed locales produced real output that the caller may want to commit.
    //   2. The failed locales will be re-queued on the next run via the manifest diff.
    //   3. A hard failure on partial success would discard completed work and require
    //      the caller to re-translate everything from scratch.
    //
    // Partial failure is surfaced via:  core.warning() + languages_failed output.
    // Callers that want strict all-or-nothing behaviour can check
    // `languages_failed != ''` themselves and fail their own step.
    //
    // Do NOT change this to `languagesFailed.length > 0` without understanding the above.
    if (languagesFailed.length > 0 && languagesCompleted.length === 0) {
      core.setFailed(`All languages failed: ${languagesFailed.join(', ')}`)
    }

    core.info('[translate] Done.')
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

run()
