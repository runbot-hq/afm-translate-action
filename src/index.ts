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
 * --write-out "\nHTTP %{http_code}": prints the HTTP status code to stderr
 * even when --silent suppresses the response body. On a 404 (no release asset
 * published yet), this surfaces "HTTP 404" alongside the curl exit-code error,
 * making first-setup failures immediately actionable without re-running with -v.
 *
 * Partial-file and zero-byte cleanup: if curl fails after writing partial
 * bytes, the try/catch calls fs.unlinkSync(dest) before re-throwing. After a
 * successful curl exit, statSync guards against two bad-file-state scenarios:
 *   1. curl exits 0 but never creates the file (e.g. RUNNER_TEMP is read-only
 *      or non-existent on a misconfigured self-hosted runner) — statSync throws
 *      ENOENT, caught and re-thrown with a clear message.
 *   2. curl exits 0 with a zero-byte file (CDN returns 200 with empty body
 *      before --fail triggers) — caught by the size === 0 check.
 * Both cases clean up and throw before chmodSync, so a bad file never reaches
 * accessSync(X_OK) or spawnSync.
 * Do NOT remove either the try/catch cleanup or the statSync guard.
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
      // --write-out prints the HTTP status code to stderr on failure.
      // With --silent + --fail alone, a 404 surfaces only as "exited with code 22".
      // This makes first-setup failures (no release asset yet) immediately actionable.
      '--write-out', '\nHTTP %{http_code}',
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

  // Guard against missing or zero-byte output.
  //
  // statSync is wrapped in try/catch because curl can exit 0 without creating
  // the file at all — e.g. if RUNNER_TEMP is read-only or non-existent on a
  // misconfigured self-hosted runner. In that case a bare statSync throws a raw
  // ENOENT with no cleanup and no useful context. We catch it, clean up, and
  // re-throw with a clear message.
  //
  // If the file exists but is zero bytes (CDN returned HTTP 200 with empty body
  // before --fail triggered), the size === 0 branch cleans up and throws.
  //
  // A zero-byte or missing file would pass chmodSync and accessSync(X_OK) but
  // cause ENOEXEC (or equivalent) at spawnSync. Catch both cases here.
  // Do NOT remove this guard.
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
 * firing. Always update both files together.
 *   permission/sandbox errors                  → 'eacces' / 'not authorized'  ✔
 *
 * macOS 26.0–26.3 caveat: on those OS versions, TranslationEngine skips the
 * LanguageAvailability preflight check (API requires 26.4). If a language pack is missing,
 * Apple's framework throws an opaque error whose message is NOT controlled by us and may
 * NOT match 'language pack not installed' below. In that case isFatalTranslateError returns
 * false and the error is retried once — harmless but inefficient.
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
    const debugInput = core.getInput('debug') === 'true'

    const translateBin = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'translate-cli-bin')

    if (!fs.existsSync(translateBin)) {
      downloadTranslateCli(translateBin)
    } else {
      core.info(`[translate] translate-cli-bin already present at ${translateBin}, skipping download`)
    }

    try {
      fs.accessSync(translateBin, fs.constants.X_OK)
    } catch {
      throw new Error(
        `translate-cli-bin at ${translateBin} is not executable. This is unexpected after download — please file a bug.`
      )
    }

    const input = core.getInput('input').trim()
    const output = core.getInput('output').trim()
    const languages = core.getInput('languages').trim()
    const config = core.getInput('config').trim()
    const manifest = core.getInput('manifest').trim()
    const sourceLanguage = core.getInput('source_language').trim()
    const quality = core.getInput('quality').trim() || 'high'
    const format = core.getInput('format').trim() || 'xcstrings'

    if (!input) {
      throw new Error('Input `input` is required (path to source .xcstrings / .strings / .md file).')
    }

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
        ? path.dirname(input)
        : input)

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
      args.push('--config', config)
    }
    if (manifest) {
      args.push('--manifest', manifest)
    }

    if (debugInput) {
      args.push('--debug')
    }

    core.info(`[translate] Running translate-cli for languages: ${languages || config || '(from config)'}`)
    core.info(`[translate] Input: ${input} → Output: ${resolvedOutput}`)

    let stdout = ''
    try {
      const r = translateCli(translateBin, args)
      stdout = r.stdout
      if (r.stderr) core.debug(`[translate] stderr: ${r.stderr}`)
    } catch (e) {
      core.debug(`[translate] Attempt 1 error: ${String(e)}`)
      if (isFatalTranslateError(e)) throw e
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

    await core.summary
      .addHeading('🌐 Translation Complete')
      .addRaw(`**Input:** \`${input}\`\n`)
      .addRaw(`**Languages:** ${languages || '(from config)'}\n`)
      .addRaw(`**Quality:** ${quality}\n`)
      .addRaw(`**${languagesCompleted.length === 0 ? 'Keys pending' : 'Keys translated'}:** ${keysTranslated}${format === 'markdown' ? ' (document)' : ''}\n`)
      .addRaw(`**Completed:** ${languagesCompleted.join(', ') || '(none)'}\n`)
      .addRaw(languagesFailed.length > 0 ? `**Failed:** ${languagesFailed.join(', ')}\n` : '')
      .addRaw(`**Runner:** ${process.env.RUNNER_NAME ?? 'unknown'}\n`)
      .write()

    if (languagesFailed.length > 0 && languagesCompleted.length === 0) {
      core.setFailed(`All languages failed: ${languagesFailed.join(', ')}`)
    }

    core.info('[translate] Done.')
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

run()
