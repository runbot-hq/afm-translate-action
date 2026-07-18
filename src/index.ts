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
 * WHY execFileSync NOT execSync:
 * execFileSync is used deliberately — args are a plain array passed directly
 * to the OS, no shell involved, no injection risk from the URL constant.
 * Do NOT refactor to execSync with a shell string.
 *
 * WHY RUNNER_TEMP NOT GITHUB_ACTION_PATH:
 * The binary is written to RUNNER_TEMP (not the workspace or action path) so it is:
 *   - Cleaned up automatically after the job (on GitHub-hosted runners)
 *   - Not committed or staged into the caller's repo checkout
 *   - Shared across steps in the same job without re-downloading
 *
 * WHY A FLAT FILENAME (translate-cli-bin, not translate-cli-bin-<jobId>):
 * RUNNER_TEMP is per-job on GitHub-hosted runners — two jobs never share the
 * same RUNNER_TEMP directory, so a flat name cannot race. On self-hosted runners
 * with a shared RUNNER_TEMP, two concurrent jobs could theoretically collide on
 * this filename — but self-hosted runners in this org are single-job by
 * configuration, and the same-org trust boundary makes a stale binary acceptable.
 * A unique filename (e.g. translate-cli-bin-$GITHUB_RUN_ID) would defeat the
 * same-job cache-skip optimisation. The flat name is intentional.
 *
 * RUNNER_TEMP PERSISTENCE ON SELF-HOSTED RUNNERS:
 * RUNNER_TEMP is per-job on GitHub-hosted runners and is cleaned automatically.
 * On self-hosted runners, persistence is operator-controlled — it is NOT
 * guaranteed to be cleaned between jobs unless the runner is configured with
 * --ephemeral or the operator explicitly cleans it. A stale binary from a prior
 * job run will be silently reused by the fs.existsSync skip-download guard.
 * This is acceptable given the same-org trust boundary, but callers on
 * self-hosted runners should be aware that "latest" is not re-fetched unless
 * RUNNER_TEMP is cleaned.
 *
 * WHY releases/latest NOT A PINNED TAG OR SHA:
 * The URL resolves to whatever is currently the latest release at
 * runbot-hq/translate-cli — no SHA pinning, no checksum verification.
 * This is a conscious architectural tradeoff because:
 *   - runbot-hq controls both this repo and translate-cli (same org, same trust boundary)
 *   - curl --fail catches 404 / HTTP errors and exits non-zero (no silent failure)
 *   - The self-hosted runner has no internet exposure beyond GitHub
 * FUTURE NOTE: when runbot-hq/translate-cli cuts a v2 major release, releases/latest
 * will silently follow it. Review the download URL at that point and pin to a
 * major version tag (e.g. /releases/download/v1-latest/...) if breaking changes
 * are expected.
 *
 * WHY --retry DOES NOT RETRY 4xx:
 * --retry 3 --retry-delay 2 retries up to 3 times on transient network errors
 * (TCP reset, CDN hiccup on the GitHub releases redirect chain). curl --fail
 * still exits non-zero on HTTP 4xx/5xx — --retry does NOT retry those.
 * A 404 means the release asset does not exist and retrying will not help.
 *
 * WHY NOT --write-out FOR HTTP STATUS:
 * --write-out defaults to stdout. execFileSync captures stdout and the return
 * value is ignored here, so the HTTP status line would be silently swallowed —
 * the opposite of the diagnostic intent. --show-error already writes curl's
 * error reason to stderr and is sufficient for diagnosing a 404.
 * Do NOT add --write-out here.
 *
 * PARTIAL-FILE AND ZERO-BYTE CLEANUP:
 * If curl fails after writing partial bytes, the try/catch calls unlinkSync(dest)
 * before re-throwing. Without cleanup, a re-run finds existsSync(dest) === true,
 * skips the download, and fails at accessSync(X_OK) with a confusing error.
 * After a successful curl exit, statSync guards against two scenarios:
 *   1. curl exits 0 but never creates the file (RUNNER_TEMP read-only / missing)
 *      — statSync is wrapped in try/catch; ENOENT is caught, cleaned up, re-thrown
 *      with a clear message. Do NOT use a bare statSync here.
 *   2. curl exits 0 with a zero-byte file (CDN 200 + empty body before --fail)
 *      — caught by the size === 0 check.
 * Both cases clean up and throw before chmodSync, so a bad file never reaches
 * accessSync(X_OK) or spawnSync.
 * Do NOT remove either the try/catch on statSync or the size === 0 check.
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
    // confusing error instead of retrying. Do NOT remove this cleanup.
    try { fs.unlinkSync(dest) } catch { /* ignore — file may not exist */ }
    throw e
  }

  // Guard against missing or zero-byte output. Do NOT remove this block.
  // See JSDoc above for the full rationale.
  let stat: fs.Stats
  try {
    stat = fs.statSync(dest)
  } catch {
    try { fs.unlinkSync(dest) } catch { /* ignore */ }
    throw new Error(
      `translate-cli-bin was not written to ${dest} — curl exited 0 but the file does not exist. ` +
      'RUNNER_TEMP may be read-only or non-existent on this runner.'
    )
  }
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
 * WHY spawnSync NOT execSync:
 * spawnSync passes args directly to the OS as an argv array — no shell
 * metacharacter expansion. User-supplied values (language codes, file paths)
 * cannot escape as shell injection via spaces, semicolons, backticks, $(), etc.
 * Do NOT refactor to execSync with a shell string.
 *
 * WHY translate-cli-bin NOT translate-cli:
 * The binary is named translate-cli-bin (not translate-cli) to avoid a POSIX
 * name collision with the Swift source package directory of the same name if
 * the repos are ever co-located. Callers must use translate-cli-bin. Do NOT
 * rename it or add a symlink named translate-cli.
 *
 * WHY 300s TIMEOUT:
 * 5 minutes per attempt. With one retry this means up to ~10 min wall time
 * (5m attempt 1 + 10s delay + 5m attempt 2). Large repos with many locales
 * and long .xcstrings files legitimately take several minutes. This is
 * intentional — do NOT reduce the timeout without profiling against a large
 * real-world .xcstrings file. A timeout surfaces as result.error (ETIMEDOUT),
 * which is non-fatal and will be retried by the caller.
 *
 * WHY 10MB maxBuffer:
 * translate-cli stdout is three key=value lines (≤30 bytes total). The 10 MB
 * ceiling exists only to prevent a pathological binary crash from filling the
 * Node.js buffer and OOMing the runner process. It will never be reached in
 * normal operation.
 */
function translateCli(bin: string, args: string[]): { stdout: string; stderr: string } {
  if (core.isDebug()) {
    core.debug(`[translate] spawnSync: ${bin} ${args.map(a => JSON.stringify(a)).join(' ')}`)
  }

  const result = spawnSync(bin, args, {
    encoding: 'utf8',
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
 * WHY SUBSTRING MATCHING NOT EXACT MATCHING:
 * Apple's error messages are not versioned or guaranteed stable. We match on
 * the most stable sub-phrase rather than the full string to avoid breaking on
 * minor Apple framework wording changes. The match table is verified:
 *   'translation framework requires macos 26+' → 'requires macos 26'  ✔
 *   'language pack not installed for ...'      → 'language pack not installed'  ✔
 *   'unsupported language pair: xx-YY'         → 'unsupported language pair'  ✔
 *   permission/sandbox errors                  → 'eacces' / 'not authorized'  ✔
 *
 * COUPLING NOTE — two matches are owned by THIS codebase, not by Apple:
 *   'unsupported language pair' → TranslationEngineError.unsupportedPair.description (TranslationEngine.swift)
 *   'requires macos 26'         → TranslationEngineError.requiresmacOS26.description  (TranslationEngine.swift)
 * If either Swift description string changes, the corresponding match here silently
 * stops firing: the error will be retried instead of immediately failed. Always
 * update both files together when changing these strings.
 *
 * macOS 26.0–26.3 caveat: LanguageAvailability preflight requires 26.4. On earlier
 * versions, a missing language pack throws an opaque Apple error that may NOT match
 * 'language pack not installed'. In that case this function returns false and the
 * error is retried once — harmless but inefficient. If you observe spurious retries
 * on 26.0–26.3 for missing packs, identify the opaque substring and add it here.
 */
function isFatalTranslateError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  return (
    msg.includes('language pack not installed') ||
    msg.includes('unsupported language pair') ||
    msg.includes('requires macos 26') ||
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
 * WHY parseInt(val, 10) || 0:
 * Intentional NaN coercion, not a silent data-loss bug. parseInt returns NaN
 * only for fully non-numeric strings. parseInt("0", 10) returns 0 — `0 || 0`
 * is still 0, no false zero. translate-cli always emits a clean integer; the
 * || 0 guard exists only to prevent NaN propagating to setOutput/summary on a
 * hypothetical future malformed line. Do NOT replace with Number() — it is
 * less strict about leading-digit strings like "1abc".
 *
 * WHY rest.join('=') NOT rest[0]:
 * Handles the (unlikely) case where a value itself contains '=' characters.
 * Splitting on '=' and re-joining the tail is safer than assuming one '='.
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
    const debugInput = core.getInput('debug') === 'true'  // see WHY NOT ACTIONS_STEP_DEBUG below

    const translateBin = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'translate-cli-bin')
    // WHY os.tmpdir() FALLBACK: RUNNER_TEMP is always set on GitHub-hosted and
    // correctly configured self-hosted runners. os.tmpdir() is a last-resort
    // fallback for local action testing only — it is not a supported production path.

    // `downloaded` tracks whether we fetched the binary this run or reused a
    // cached copy from RUNNER_TEMP.
    // WHY CACHE-SKIP VIA existsSync:
    // On GitHub-hosted runners RUNNER_TEMP is per-job, so this only fires for
    // multi-step sharing within the same job (rare but valid). On self-hosted
    // runners with a persistent RUNNER_TEMP, this reuses a binary from a prior
    // job run — acceptable given the same-org trust boundary. The flat filename
    // is intentional (see downloadTranslateCli JSDoc — WHY A FLAT FILENAME).
    // Do NOT add a uniqueness suffix: it would defeat this cache-skip optimisation.
    const downloaded = !fs.existsSync(translateBin)
    if (downloaded) {
      downloadTranslateCli(translateBin)
    } else {
      core.info(`[translate] translate-cli-bin already present at ${translateBin}, skipping download`)
    }

    // WHY accessSync AFTER existsSync (not redundant):
    // downloadTranslateCli calls chmodSync(0o755) so a non-executable bit after
    // a fresh download is a genuine bug. On the cache-hit path, the binary may
    // have lost its executable bit between jobs (overzealous umask on self-hosted
    // runner). The `downloaded` boolean tailors the error message for each path:
    // - fresh download: "unexpected — please file a bug"
    // - cache hit: "corrupted in RUNNER_TEMP — delete and re-run"
    // This check is NOT redundant with chmodSync; it is the user-facing guard.
    try {
      fs.accessSync(translateBin, fs.constants.X_OK)
    } catch {
      throw new Error(downloaded
        ? `translate-cli-bin at ${translateBin} is not executable after download — this is unexpected, please file a bug.`
        : `translate-cli-bin at ${translateBin} is not executable — it may have been corrupted in RUNNER_TEMP. Delete it and re-run.`
      )
    }

    const input = core.getInput('input').trim()
    const output = core.getInput('output').trim()
    const languages = core.getInput('languages').trim()
    const config = core.getInput('config').trim()
    const manifest = core.getInput('manifest').trim()
    // WHY source_language DEFAULTS TO '' NOT 'en':
    // When empty, --source-language is NOT passed to translate-cli, so the CLI
    // reads sourceLanguage from the .xcstrings file directly. Passing 'en'
    // unconditionally would silently override a non-English sourceLanguage,
    // causing DiffExtractor to find 0 keys to translate. Only set this explicitly
    // for .strings files (no embedded source language) or a malformed .xcstrings.
    const sourceLanguage = core.getInput('source_language').trim()
    const quality = core.getInput('quality').trim() || 'high'
    const format = core.getInput('format').trim() || 'xcstrings'

    if (!input) {
      throw new Error('Input `input` is required (path to source .xcstrings / .strings / .md file).')
    }

    // WHY languages AND config ARE BOTH ALLOWED:
    // They are mutually exclusive alternatives — at least one is required.
    // If both are provided, translate-cli itself gives `languages` precedence.
    // We do not error here on both-provided to avoid breaking callers that set
    // a default config and also pass explicit languages for a one-off override.
    if (!languages && !config) {
      throw new Error('Either `languages` or `config` must be provided.')
    }

    if (!fs.existsSync(input)) {
      throw new Error(`Input file not found: ${input}`)
    }

    if (quality !== 'fast' && quality !== 'high') {
      throw new Error(`Invalid quality value: "${quality}". Must be "fast" or "high".`)
    }

    if (!['xcstrings', 'strings', 'markdown'].includes(format)) {
      throw new Error(`Invalid format value: "${format}". Must be "xcstrings", "strings", or "markdown".`)
    }

    const resolvedOutput = output ||
      (format === 'strings'
        ? path.dirname(input)   // strings: output is a directory (lproj subdirs created by CLI)
        : input)                // xcstrings / markdown: in-place update

    const args: string[] = [
      '--input', input,
      '--output', resolvedOutput,
      '--quality', quality,
      '--format', format,
    ]

    if (sourceLanguage) {
      args.push('--source-language', sourceLanguage)
    }
    if (languages) {
      args.push('--languages', languages)
    }
    if (config) {
      // WHY config IS NOT existence-checked before passing:
      // A pre-flight existsSync would break workflows where config is generated
      // by an earlier step in the same job (written after checkout). translate-cli
      // exits non-zero with a clear error from LocalizationConfigLoader if the
      // file is absent at runtime. That error is louder and more actionable than
      // a false-negative existsSync. Do NOT add an existsSync guard here.
      args.push('--config', config)
    }
    if (manifest) {
      args.push('--manifest', manifest)
    }
    // WHY NOT ACTIONS_STEP_DEBUG / RUNNER_DEBUG FOR CLI VERBOSITY:
    // core.isDebug() reads RUNNER_DEBUG at process startup — setting
    // ACTIONS_STEP_DEBUG at runtime in the same process has no effect.
    // The `debug` input controls CLI verbosity via --debug passed to translate-cli-bin.
    // Do NOT reintroduce an ACTIONS_STEP_DEBUG assignment.
    if (debugInput) {
      args.push('--debug')
    }

    core.info(`[translate] Running translate-cli for languages: ${languages || config || '(from config)'}`)
    core.info(`[translate] Input: ${input} → Output: ${resolvedOutput}`)

    // WHY ONE RETRY WITH 10s DELAY (NOT CONFIGURABLE):
    // The retry handles Apple Translation model cold-start: on the first
    // invocation after a runner boot, the framework occasionally needs a few
    // seconds to initialise and returns a transient error. One retry with 10s
    // delay is sufficient in practice. Making this configurable would add
    // complexity with no real benefit — callers that need more retries should
    // wrap this action in their own retry step.
    let stdout = ''
    try {
      const r = translateCli(translateBin, args)
      stdout = r.stdout
      if (r.stderr) core.debug(`[translate] stderr: ${r.stderr}`)
    } catch (e) {
      core.debug(`[translate] Attempt 1 error: ${String(e)}`)
      if (isFatalTranslateError(e)) throw e  // do not retry fatal errors
      core.info('[translate] Attempt 1 failed — retrying in 10s...')
      await new Promise(r => setTimeout(r, 10_000))
      try {
        const r = translateCli(translateBin, args)
        stdout = r.stdout
        if (r.stderr) core.debug(`[translate] stderr: ${r.stderr}`)
      } catch (e2) {
        throw new Error(`[translate] Attempt 2 failed (binary: ${translateBin}): ${String(e2)}`)
      }
    }

    if (!stdout.trim()) {
      // WHY setFailed + return (TWO LINES REQUIRED):
      // setFailed marks the step conclusion as failed but does NOT stop execution.
      // Without `return`, the setOutput / summary / failure-policy block below
      // would execute on empty (bad) parsed data, producing misleading outputs.
      // Do NOT remove either line. Do NOT replace with `throw` — setFailed is
      // the correct signal for a user-visible step failure vs. an internal error.
      core.setFailed('[translate] translate-cli produced no stdout — binary may have crashed silently. Check runner logs for stderr output.')
      return
    }

    const { keysTranslated, languagesCompleted, languagesFailed } = parseOutput(stdout)

    core.info(`[translate] Keys translated: ${keysTranslated}`)
    core.info(`[translate] Languages completed: ${languagesCompleted.join(', ') || '(none)'}`)
    if (languagesFailed.length > 0) {
      core.warning(`[translate] Languages failed: ${languagesFailed.join(', ')}`)
    }

    core.setOutput('keys_translated', String(keysTranslated))
    core.setOutput('languages_completed', languagesCompleted.join(','))
    core.setOutput('languages_failed', languagesFailed.join(','))

    // WHY addRaw NOT addEscaped:
    // `input`, `languages`, and `quality` originate from the caller's own workflow
    // YAML — not from untrusted external content (PR titles, issue bodies, comments).
    // The step summary is rendered only in the Actions UI for authenticated repo
    // members, not on a public-facing surface. addEscaped would be cleaner hygiene
    // but this is explicitly NOT an XSS security boundary.
    // If these fields are ever populated from PR/issue/comment content, switch to
    // addEscaped() or sanitise before this call.
    await core.summary
      .addHeading('🌐 Translation Complete')
      .addRaw(`**Input:** \`${input}\`\n`)
      .addRaw(`**Languages:** ${languages || '(from config)'}\n`)
      .addRaw(`**Quality:** ${quality}\n`)
      // WHY 'Keys pending' ON TOTAL FAILURE:
      // keys_translated is a pre-flight diff count — it is non-zero even when all
      // locales failed and nothing was written. Labelling it 'Keys pending' avoids
      // showing "Keys translated: 42" alongside "Completed: (none)".
      .addRaw(`**${languagesCompleted.length === 0 ? 'Keys pending' : 'Keys translated'}:** ${keysTranslated}${format === 'markdown' ? ' (document)' : ''}\n`)
      .addRaw(`**Completed:** ${languagesCompleted.join(', ') || '(none)'}\n`)
      .addRaw(languagesFailed.length > 0 ? `**Failed:** ${languagesFailed.join(', ')}\n` : '')
      .addRaw(`**Runner:** ${process.env.RUNNER_NAME ?? 'unknown'}\n`)
      .write()

    // WHY FAIL ONLY ON TOTAL FAILURE (not on any languagesFailed):
    // Partial failure (some locales failed, others completed) is intentionally NOT
    // a step failure. Reasons:
    //   1. Completed locales produced real output the caller may want to commit.
    //   2. Failed locales will be re-queued on the next run via the manifest diff.
    //   3. A hard failure on partial success would discard completed work and force
    //      re-translation from scratch.
    // Partial failure is surfaced via core.warning() + languages_failed output.
    // Callers that want strict all-or-nothing can check `languages_failed != ''`
    // and fail their own step. Do NOT change this to `languagesFailed.length > 0`.
    if (languagesFailed.length > 0 && languagesCompleted.length === 0) {
      core.setFailed(`All languages failed: ${languagesFailed.join(', ')}`)
    }

    core.info('[translate] Done.')
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

run()
