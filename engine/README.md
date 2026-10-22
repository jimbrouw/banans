# RoughCut Engine

A local companion service for the RoughCut Premiere panel. Optional: the panel uses Premiere's own transcript first and only needs the engine for exact pause detection, Whisper when Premiere hasn't transcribed, the AI pass, and Podcast Mode's mic detection. UXP panels can't run binaries, but they can `fetch` localhost, so the heavy work runs here. It's free, needs no account and sends nothing to the cloud.

- **Listens on `localhost:7317` only.** The panel must use the name `localhost`: Premiere on macOS only allows plain `http://` to that host (its App Transport Security exception), not `127.0.0.1`. The panel sends a media **file path**, never the file itself.
- **Mac only (Apple Silicon).** Transcription uses [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper), which runs on Metal.

## Run

**Normal use: start on demand.** Run this once:

```bash
./install.sh
```

macOS then listens on localhost:7317 (IPv4 and IPv6) without running anything. When the RoughCut panel connects, macOS starts the engine (about 0.3 s); after 10 minutes with no requests it quits. Nothing runs while you're not using Premiere. Undo with `./uninstall.sh`. Engine output: `~/Library/Logs/RoughCut/engine.log`.

**Development: run by hand.** This binds the port itself and stays up:

```bash
uv run roughcut-engine
```

The first `uv run` installs dependencies. The first transcription downloads the model (`whisper-large-v3-turbo`, about 1.6 GB) into `~/.cache/huggingface`.

| Env var | Default | Meaning |
|---|---|---|
| `RC_ENGINE_PORT` | `7317` | Port. If you change it, change `ENGINE_URL` in `src/engineClient.ts` and the manifest domain too. |
| `RC_WHISPER_MODEL` | `mlx-community/whisper-large-v3-turbo` | Any mlx-community whisper repo. `whisper-tiny` is useful for quick tests. |
| `RC_ENGINE_IDLE` | `600` | Seconds without requests before an on-demand engine quits. |
| `RC_ENGINE_CACHE` | `~/Library/Caches/roughcut-engine` | Result cache and extracted WAVs. |

## API

| Route | Body | Returns |
|---|---|---|
| `GET /health` | | `{ok, version, model}` |
| `POST /silences` | `{path, noise_db=-35, min_silence=0.5}` | `{duration, silences:[{start,end}]}` in seconds |
| `POST /transcribe` | `{path, model?, language?}` | `{model, language, segments:[{start,end,text}], words:[{text,start,end,prob,filler,segment}]}` |
| `POST /levels` | `{path, channel?, rate=10}` | `{rate, channel, duration, db:[...]}`: loudness per 1/rate s, for Podcast Mode's mic fallback |
| `POST /selects` | `{units, speakers?, provider, api_key?, audio_path?, count=5}` | `{model, clips:[{rank,title,title_check,type,idea,opening_line,why,pieces,duration,hook_pulled_forward,hook_score,energy}], proposed, valid, shortlisted}` |
| `POST /jobs/selects` | same as `/selects` | `{job}`; poll `GET /jobs/{id}` → `{status, step, result, error, seconds}` (use this from clients: a local model takes minutes) |
| `POST /chapters` | `{units, provider, api_key?}` | `{model, valid, chapters:[{start,label,title,seconds}], text}` |
| `POST /edit` | `{units:[{id,start,end,text}], provider:"claude"\|"ollama" (default claude), api_key?, instruction?, prefer_last_take}` | `{provider, model, removals:[{start,end,ids,reason,note}], keep_ids}` |

- Results are cached by path, file size, mtime and parameters, so a re-run is instant.
- `filler: true` marks hard fillers only (um, uh, er, hmm and similar). Context-dependent ones like "like" and "you know" are left for the AI pass.
- A disfluent initial prompt nudges Whisper to keep fillers instead of cleaning them out.
- Transcription is synchronous and runs one job at a time. A long episode keeps the request open for minutes; `/health` stays responsive meanwhile.

## AI pass (`/edit`)

The panel sends sentence-sized transcript lines. The model returns **line ids** to remove (retake, false start, repeat, off-topic, or "instruction" for Chat Edit) and to keep; the engine maps ids back to time ranges. The model never deals with timestamps.

- **Claude (default, your key).** See below.
- **Ollama (optional, free, offline).** Chosen in the Setup tab. It found none of the editor's two Shorts in the selects eval (Claude Sonnet found one). Install it from [ollama.com/download](https://ollama.com/download), then pull the model:
  ```bash
  ollama pull qwen3:8b
  ```
  Override the model with `RC_OLLAMA_MODEL` and the address with `RC_OLLAMA_URL`. Requests use Ollama's JSON-schema `format`, `think: false` and temperature 0.
- **Claude.** Uses the official `anthropic` SDK with structured JSON output. To keep cost down it only accepts `claude-sonnet-5-5` (effort low, the default) or `claude-haiku-5-5` (effort high), picked in the Setup tab; any other model, Opus included, is refused, and there are no server-side fallbacks. The key is sent per request from the panel and is never stored or logged by the engine.
- Long transcripts go in chunks of 250 lines with 15 lines of overlap.

## Test

```bash
uv run pytest                          # fast: parsing, real ffmpeg on generated audio, API routes
RC_ENGINE_SLOW=1 uv run pytest         # also runs real transcription (macOS `say` + whisper-tiny)
```
