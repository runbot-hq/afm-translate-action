# translation-framework-action

A GitHub Action that translates `.xcstrings` (or `.strings` / Markdown) files using the Apple Translation framework on a self-hosted macOS runner.

> **Requires:** Self-hosted macOS 26+ arm64 runner with Apple Translation language packs installed.
> Cannot run on GitHub-hosted Linux or Windows runners.

## Usage

```yaml
- uses: runbot-hq/translation-framework-action@v1
  with:
    input: Sources/App/Localizable.xcstrings
    languages: de,fr,ja,zh-Hans
    quality: high   # or fast
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `input` | Yes | — | Path to source `.xcstrings`, `.strings`, or `.md` file |
| `output` | No | Same as `input` (xcstrings/markdown); `dirname(input)` (strings) | Write path for translated output |
| `languages` | No¹ | — | Comma-separated target language codes (e.g. `de,fr,ja,zh-Hans`) |
| `config` | No¹ | — | Path to `localization.config.json` with `targetLanguages` array (alternative to `languages`) |
| `manifest` | No | `dirname(input)/.translation-manifest.json` | Path to incremental manifest file |
| `source_language` | No | *(reads from `.xcstrings` file)* | Source language override. Leave empty unless the `.xcstrings` `sourceLanguage` field is wrong. |
| `quality` | No | `high` | `high` (highFidelity / Apple Intelligence) or `fast` (lowLatency NMT) |
| `format` | No | `xcstrings` | `xcstrings`, `strings`, or `markdown` |
| `debug` | No | `false` | Enable verbose logging |

¹ Exactly one of `languages` or `config` is required.

## Outputs

| Output | Description |
|--------|-------------|
| `keys_translated` | `xcstrings`/`strings`: number of source keys identified for translation this run (pre-flight diff count — can be `> 0` even if all locales failed). `markdown`: `1` if ≥1 locale completed, `0` if all failed. **Do not gate commit steps on this value** — use `languages_completed` instead. |
| `languages_completed` | Comma-separated language codes that completed successfully this run. Use this to gate commit or PR steps. |
| `languages_failed` | Comma-separated language codes that failed (empty string if none failed). |

## Example workflows

### Translate an `.xcstrings` file (languages inline)

```yaml
name: Translate strings

on:
  push:
    paths:
      - 'Sources/**/*.xcstrings'

permissions:
  contents: write

jobs:
  translate:
    runs-on: [self-hosted, macOS, arm64]
    steps:
      - uses: actions/checkout@v4

      - name: Translate
        id: translate
        uses: runbot-hq/translation-framework-action@v1
        with:
          input: Sources/App/Localizable.xcstrings
          languages: de,fr,ja,zh-Hans
          quality: high

      - name: Commit translations
        if: steps.translate.outputs.languages_completed != ''
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add Sources/App/Localizable.xcstrings
          git add Sources/App/.translation-manifest.json
          git diff --cached --quiet || git commit -m "chore: update translations (${{ steps.translate.outputs.languages_completed }})"
          git push
```

### Translate using a config file

```yaml
      - name: Translate
        id: translate
        uses: runbot-hq/translation-framework-action@v1
        with:
          input: Sources/App/Localizable.xcstrings
          config: localization.config.json
          quality: high
```

`localization.config.json`:
```json
{ "targetLanguages": ["de", "fr", "ja", "zh-Hans"] }
```

## Binary

`translate-cli-bin` is the compiled Swift binary from [runbot-hq/translate-cli](https://github.com/runbot-hq/translate-cli), vendored here for zero runtime dependencies. To update it, download the new binary from `runbot-hq/translate-cli` releases and commit it here.

## Language packs

Language packs must be pre-installed on the runner via **System Settings → Language & Region → Translation Languages**. The action will fail with a clear error message if a required pack is missing.
