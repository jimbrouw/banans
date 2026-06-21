# Premier Auto Editor merge review

Comparison source: `/Users/standard/Developer/Premier_Auto_editor_plugin`

## Ported into RoughCut

- Transcript-gap pause detection with configurable minimum duration.
- Low, medium, and high filler-review aggressiveness.
- Adjacent trim-region merging.
- Minimum camera-shot duration.
- Short acknowledgement/interjection suppression.
- Wide-shot suggestions for overlapping speakers.
- Speaker-to-camera mapping used by the camera decision plan.

These features produce selectable review markers on a cloned sequence. They do not perform unsupported native multicam angle switching.

## Retained from RoughCut

- Premiere UXP rather than legacy CEP.
- Adobe-supported `premierepro` APIs rather than QE DOM and menu-command automation.
- Premiere transcript reuse rather than mandatory duplicate Whisper transcription.
- Typed host adapter and testable pure decision engine.
- Clone-first, undoable marker transactions.
- Explicit errors rather than silent mock results in the Premiere host.

## Not merged

- CEP `CSInterface` and ExtendScript execution.
- Undocumented QE DOM razor operations and simulated menu clicks.
- Destructive ripple-delete automation.
- Auto-started unrestricted FastAPI/CORS service.
- The full Whisper, Torch, pyannote, and ffmpeg Python environment as a required dependency.
- Provider-specific Groq editorial analysis with mock data returned on API failure.
- UI panels whose backend paths are placeholders.

## Candidate next layer

The older Python DSP code has useful RMS caching, silence detection, and per-microphone activity analysis. It should become an optional, versioned local analysis service only after the UXP plugin can launch/connect to it securely and the service has a narrow authenticated localhost API. Until then, transcript-derived decisions keep installation small and the Premiere workflow testable.

## Source verification snapshot

- The older Python sample pipeline completed against its bundled WAV fixture: 2 cut regions, 3.50 seconds removed, and 3 camera switches.
- Its pyannote/TorchCodec environment emitted native FFmpeg library-loading warnings, so diarization packaging is not production-ready.
- Its React/webpack build failed under the currently resolved Node runtime on nullish-coalescing syntax.
- Several multicam paths, social features, and editorial failure paths still return placeholders or mock data.
- The source worktree already contained extensive uncommitted changes; no source files were modified or reverted during this review.
