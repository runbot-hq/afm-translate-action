import * as core from '@actions/core'
import { spawnSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calls translate-cli-bin via spawnSync with an explicit argv array.
 * spawnSync is used instead of execSync — args pass directly to the OS,
 * no shell metacharacter risk from user-supplied language codes or paths.
 */
function translateCli(bin: string, args: string[]): { stdout: string; stderr: string } {
  if (core.isDebug()) {
    core.debug(`[translate] spawnSync: ${bin} ${args.map(a => JSON.stringify(a)).join(' ')}`)
  }

  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 300_000, // 5 min — large xcstrings files can take time
    maxBuffer: 10 * 1024 * 1024,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`translate-cli exited ${result.status}: ${result.stderr?.trim()}`)
  }

  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Returns true if the error is fatal and a retry won't help.
 * Language pack not installed, unsupported pair, macOS version errors.
 */
function isFatalTranslateError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  return (
    msg.includes('language pack not installed') ||
    msg.includes('unsupported language pair') ||
    msg.includes('requires macos 26') ||
    msg.includes('translation framework') ||
    msg.includes('eacces') ||
    msg.includes('not authorized') ||
    msg.includes('mdm policy')
  )
}

/**
 * Parses translate-cli stdout for key=value output lines.
 * translate-cli emits:
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
    if (core.getInput('debug') === 'true') process.env.ACTIONS_STEP_DEBUG = '1'

    const actionPath = process.env.GITHUB_ACTION_PATH ?? path.join(__dirname, '..')

    // Binary is committed as translate-cli-bin — same vendoring pattern as
    // afm-cli-bin in afm-release-notes-action. Do NOT rename to translate-cli
    // to avoid any future name collision with a source directory.
    const translateBin = path.join(actionPath, 'translate-cli-bin')

    if (!fs.existsSync(translateBin)) {
      throw new Error(
        `translate-cli-bin binary not found at ${translateBin}. ` +
        'This action requires a self-hosted macOS 26+ arm64 runner with Apple Translation enabled. ' +
        'It cannot run on GitHub-hosted Linux or Windows runners.'
      )
    }

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
    const sourceLanguage = core.getInput('source_language').trim() || 'en'
    const quality = core.getInput('quality').trim() || 'high'
    const format = core.getInput('format').trim() || 'xcstrings'

    // Runtime guards: input is required unless config provides it
    if (!input) {
      throw new Error('Input `input` is required (path to source .xcstrings / .strings / .md file).')
    }

    if (!languages && !config) {
      throw new Error('Either `languages` or `config` must be provided.')
    }

    if (!fs.existsSync(input)) {
      throw new Error(`Input file not found: ${input}`)
    }

    // Validate quality
    if (quality !== 'fast' && quality !== 'high') {
      throw new Error(`Invalid quality value: "${quality}". Must be "fast" or "high".`)
    }

    // Validate format
    if (!['xcstrings', 'strings', 'markdown'].includes(format)) {
      throw new Error(`Invalid format value: "${format}". Must be "xcstrings", "strings", or "markdown".`)
    }

    // Resolve output:
    // - xcstrings/markdown: output is a file path; default to same as input (in-place update)
    // - strings: output is a directory; default to dirname(input)
    const resolvedOutput = output ||
      (format === 'strings'
        ? path.dirname(input)
        : input)

    const args: string[] = [
      '--input', input,
      '--output', resolvedOutput,
      '--source-language', sourceLanguage,
      '--quality', quality,
      '--format', format,
    ]

    if (languages) {
      args.push('--languages', languages)
    }
    if (config) {
      args.push('--config', config)
    }
    if (manifest) {
      args.push('--manifest', manifest)
    }

    core.info(`[translate] Running translate-cli for languages: ${languages || config || '(from config)'}`)
    core.info(`[translate] Input: ${input} → Output: ${resolvedOutput}`)

    // Call translate-cli — one retry on non-fatal errors (model cold-start)
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
      core.warning('[translate] translate-cli produced no output — translation may have found nothing to translate')
    }

    // Parse output
    const { keysTranslated, languagesCompleted, languagesFailed } = parseOutput(stdout)

    core.info(`[translate] Keys translated: ${keysTranslated}`)
    core.info(`[translate] Languages completed: ${languagesCompleted.join(', ') || '(none)'}`)  
    if (languagesFailed.length > 0) {
      core.warning(`[translate] Languages failed: ${languagesFailed.join(', ')}`)
    }

    // Set outputs
    core.setOutput('keys_translated', String(keysTranslated))
    core.setOutput('languages_completed', languagesCompleted.join(','))
    core.setOutput('languages_failed', languagesFailed.join(','))

    // Step summary
    await core.summary
      .addHeading('🌐 Translation Complete')
      .addRaw(`**Input:** \`${input}\`\n`)
      .addRaw(`**Languages:** ${languages || '(from config)'}\n`)
      .addRaw(`**Quality:** ${quality}\n`)
      .addRaw(`**Keys translated:** ${keysTranslated}\n`)
      .addRaw(`**Completed:** ${languagesCompleted.join(', ') || '(none)'}\n`)
      .addRaw(languagesFailed.length > 0 ? `**Failed:** ${languagesFailed.join(', ')}\n` : '')
      .addRaw(`**Runner:** ${process.env.RUNNER_NAME ?? 'unknown'}\n`)
      .write()

    // Fail the step if ANY language failed and none completed
    if (languagesFailed.length > 0 && languagesCompleted.length === 0) {
      core.setFailed(`All languages failed: ${languagesFailed.join(', ')}`)
    }

    core.info('[translate] Done.')
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

run()
