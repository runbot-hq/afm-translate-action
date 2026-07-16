import * as core from '@actions/core'
import { spawnSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

    const actionPath = process.env.GITHUB_ACTION_PATH ?? path.join(__dirname, '..')

    // Binary is committed as `translate-cli-bin` (not `translate-cli`) to avoid
    // any future name collision with a source directory of the same name.
    // Same vendoring pattern used by `afm-cli-bin` in afm-release-notes-action.
    // The binary is updated manually: download the new build from runbot-hq/translate-cli
    // releases and commit it to the repo root.
    //
    // This action has zero runtime dependencies: no gh, curl, or network calls happen
    // when the action runs. Everything needed is committed to this repo.
    const translateBin = path.join(actionPath, 'translate-cli-bin')

    if (!fs.existsSync(translateBin)) {
      throw new Error(
        `translate-cli-bin binary not found at ${translateBin}. ` +
        'This action requires a self-hosted macOS 26+ arm64 runner with Apple Translation enabled. ' +
        'It cannot run on GitHub-hosted Linux or Windows runners.'
      )
    }

    // Check executable bit explicitly: a missing `+x` bit is a common post-checkout
    // state on some runners and produces a confusing EACCES error otherwise.
    try {
      fs.accessSync(translateBin, fs.constants.X_OK)
    } catch {
      throw new Error(
        `translate-cli-bin at ${translateBin} is not executable. Run: chmod +x translate-cli-bin and recommit.`
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
      // In markdown mode keys_translated is 0 or 1 (the document is one unit, not a key count).
      // Label it differently so callers reading the summary aren't confused by "Keys translated: 1"
      // on a multi-locale markdown run.
      .addRaw(`**Keys translated:** ${keysTranslated}${format === 'markdown' ? ' (document)' : ''}\n`)
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
