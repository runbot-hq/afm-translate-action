# translation-framework-action

A GitHub Action that translates `.xcstrings` (or `.strings` / Markdown) files using the Apple Translation framework on a self-hosted macOS runner.

> **Requires:** Self-hosted macOS 26+ arm64 runner with Apple Translation language packs installed.
> Cannot run on GitHub-hosted Linux or Windows runners.

## Usage

```yaml
- uses: runbot-hq/translation-framework-action@v1
  with:
    input: Sources/App/Localizable.xcstrings
    output: Sources/App/
    languages: de,fr,ja,zh-Hans
    quality: high   # or fast
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `input` | Yes | — | Path to source `.xcstrings`, `.strings`, or `.md` file |
| `output` | Yes | — | Directory where translated files are written |
| `languages` | Yes | — | Comma-separated target language codes (e.g. `de,fr,ja,zh-Hans`) |
| `source_language` | No | `en` | Source language code |
| `quality` | No | `high` | `high` (highFidelity / Apple Intelligence) or `fast` (lowLatency) |
| `format` | No | `xcstrings` | `xcstrings`, `strings`, or `markdown` |
| `debug` | No | `false` | Enable verbose logging |

## Outputs

| Output | Description |
|--------|-------------|
| `keys_translated` | Number of string keys translated |
| `languages_completed` | Comma-separated list of language codes that completed successfully |
| `languages_failed` | Comma-separated list of language codes that failed (empty if none) |

## Example workflow

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
          output: Sources/App/
          languages: de,fr,ja,zh-Hans
          quality: high

      - name: Commit translations
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add Sources/App/
          git diff --cached --quiet || git commit -m "chore: update translations (${{ steps.translate.outputs.languages_completed }})"
          git push
```

## Binary

`translate-cli-bin` is the compiled Swift binary from [runbot-hq/translate-cli](https://github.com/runbot-hq/translate-cli), vendored here for zero runtime dependencies. To update it, download the new binary from `runbot-hq/translate-cli` releases and commit it here.

## Language packs

Language packs must be pre-installed on the runner via **System Settings → Language & Region → Translation Languages**. The action will fail with a clear error message if a required pack is missing.
