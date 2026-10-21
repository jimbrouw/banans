# RoughCut Engine

A local companion service for the RoughCut Premiere panel. UXP panels can't run binaries, but they can `fetch` localhost, so the heavy work runs here. It's free, needs no account and sends nothing to the cloud.

- **Binds to `127.0.0.1:7317` only.** The panel sends a media **file path**, never the file itself.
- **Mac only (Apple Silicon).** Transcription uses [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper), which runs on Metal.

## Run

```bash
cd engine
uv run roughcut-engine
```

The first `uv run` installs dependencies. The first transcription downloads the model (`whisper-large-v3-turbo`, about 1.6 GB) into `~/.cache/huggingface`.

| Env var | Default | Meaning |
|---|---|---|
| `RC_ENGINE_PORT` | `7317` | Port. If you change it, change `ENGINE_URL` in `src/engineClient.ts` and the manifest domain too. |
| `RC_WHISPER_MODEL` | `mlx-community/whisper-large-v3-turbo` | Any mlx-community whisper repo. `whisper-tiny` is useful for quick tests. |
| `RC_ENGINE_CACHE` | `~/Library/Caches/roughcut-engine` | Result cache and extracted WAVs. |

## API

| Route | Body | Returns |
|---|---|---|
| `GET /health` | | `{ok, version, model}` |
| `POST /silences` | `{path, noise_db=-35, min_silence=0.5}` | `{duration, silences:[{start,end}]}` in seconds |
| `POST /transcribe` | `{path, model?, language?}` | `{model, language, segments:[{start,end,text}], words:[{text,start,end,prob,filler,segment}]}` |
| `POST /edit` | `{units:[{id,start,end,text}], provider:"ollama"\|"claude", api_key?, instruction?, prefer_last_take}` | `{provider, model, removals:[{start,end,ids,reason,note}], keep_ids}` |

- Results are cached by path, file size, mtime and parameters, so a re-run is instant.
- `filler: true` marks hard fillers only (um, uh, er, hmm and similar). Context-dependent ones like "like" and "you know" are left for the AI pass.
- A disfluent initial prompt nudges Whisper to keep fillers instead of cleaning them out.
- Transcription is synchronous and runs one job at a time. A long episode keeps the request open for minutes; `/health` stays responsive meanwhile.

## AI pass (`/edit`)

The panel sends sentence-sized transcript lines. The model returns **line ids** to remove (retake, false start, repeat, off-topic, or "instruction" for Chat Edit) and to keep; the engine maps ids back to time ranges. The model never deals with timestamps.

- **Ollama (default, free, offline).** Install it from [ollama.com](https://ollama.com), then pull the model:
  ```bash
  ollama pull qwen3:8b
  ```
  Override the model with `RC_OLLAMA_MODEL` and the address with `RC_OLLAMA_URL`. Requests use Ollama's JSON-schema `format`, `think: false` and temperature 0.
- **Claude (optional, your key).** Uses the official `anthropic` SDK with `claude-opus-5-5` at `effort: high`, structured JSON output, and server-side refusal fallback (`fallbacks: "default"`). The key is sent per request from the panel and is never stored or logged by the engine.
- Long transcripts go in chunks of 250 lines with 15 lines of overlap.

## Test

```bash
uv run pytest                          # fast: parsing, real ffmpeg on generated audio, API routes
RC_ENGINE_SLOW=1 uv run pytest         # also runs real transcription (macOS `say` + whisper-tiny)
```
