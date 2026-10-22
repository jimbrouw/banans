# Setting up RoughCut on another Mac

How to install RoughCut on a second Mac (for example the editing Mac mini). It takes about 20 minutes. You need macOS on Apple silicon, Premiere Pro 2026 and the Adobe UXP Developer Tool.

## Space needed

| What | Size |
|---|---|
| Project and `node_modules` | about 0.5 GB |
| Engine (Python and Whisper libraries) | about 1 GB |
| Whisper model, downloaded on the first transcription | about 1.6 GB |
| Optional: Ollama with `qwen3:8b` | about 5.5 GB |

## 1. Install the tools

Install Homebrew from [brew.sh](https://brew.sh) if the Mac doesn't have it, then:

```bash
brew install node ffmpeg uv
```

## 2. Get the project

```bash
cd ~/Developer
git clone https://github.com/jimbrouw/banans.git Roughcut
cd Roughcut
git checkout feature/autoedit-parity   # until PR 4 is merged; then stay on main
npm install
npm run build:uxp
```

## 3. Install the engine

```bash
engine/install.sh
```

This sets the engine up to start only when the RoughCut panel connects, and to quit after 10 idle minutes. Nothing runs at login or in the background. Undo it with `engine/uninstall.sh`.

## 4. Load the plugin in Premiere

1. Open the Adobe UXP Developer Tool.
2. Choose **Add Plugin** and select `plugin-dist/manifest.json` in the project folder.
3. Click **Load**. RoughCut appears in Premiere under **Window → UXP Plugins**.

## 5. Settings on the new Mac

Settings stay on each Mac, so enter them again in the **Setup** tab:

- **Claude API key:** from [console.anthropic.com](https://console.anthropic.com/settings/keys). Never paste it into chat or commit it.
- **Claude model:** Sonnet 5.5 (default) or Haiku 5.5. Opus is never used.

To run the selects eval on this Mac, also add the key to `~/.zshrc`:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

## Optional: local AI with Ollama

Ollama runs a free AI model on the Mac itself, with no API key and no internet.

1. Download and install it from [ollama.com/download](https://ollama.com/download).
2. Get the model RoughCut used: `ollama pull qwen3:8b`.

Two things to know before relying on it:

- **The current build only uses Claude.** The Ollama option was removed in commit `d697e1b`, so RoughCut needs the option back before it can use Ollama.
- **qwen3:8b scored lowest in testing.** On the Kate Courtney episode it found none of the editor's two published Shorts; Claude Sonnet found one.

Ollama's Mac app starts at login by default. Turn that off in its settings to keep to "nothing runs in the background".

## Checking it works

- **Setup tab:** should say the engine is running.
- **Run log:** the **Setup** tab shows where it is; one line per action with OK or FAIL.
- **Engine log:** `~/Library/Logs/RoughCut/engine.log`.
