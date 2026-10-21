import type { TranscriptSegment } from './types'
import { claudeModel } from './settings'

/**
 * A single shot in the Energy Reset cut plan — what camera angle to use and
 * when to cut to it, relative to the start of the cold-open window.
 */
export interface ColdOpenShot {
  /** Offset in seconds from startSeconds where this cut lands. */
  offsetSeconds: number
  /**
   * Which camera angle to use.
   * - guest_tight  : close single on the speaking guest
   * - host_reaction: cut to host's face while guest audio continues
   * - wide         : studio/wide shot establishing space
   */
  shot: 'guest_tight' | 'host_reaction' | 'wide'
  /** Optional one-line note for the editor (e.g. "emphasis punch-in on 'fire'"). */
  note?: string
  /** True when this cut should receive a digital punch-in (scale 100→103%). */
  punch?: boolean
  /** J-cut: audio from next clip leads video by this many seconds (0 = no J-cut). */
  jCutSeconds?: number
  /** L-cut: audio from this clip trails into next clip by this many seconds (0 = no L-cut). */
  lCutSeconds?: number
}

export interface ColdOpenOption {
  /** Start of the clip in sequence seconds. */
  startSeconds: number
  /** End of the clip in sequence seconds. */
  endSeconds: number
  /** Hook archetype, e.g. "In Media Res", "Open Loop", "Paradigm Shift". */
  archetype: string
  /** Exact verbatim text to cut. */
  script: string
  /** Why this keeps a viewer from clicking away in the first 5 seconds. */
  justification: string
  /**
   * Energy Reset shot list for internal multi-cam cutting.
   * Claude populates this following the 3–4s max per angle rule.
   * May be empty/absent if the window is too short for multiple cuts.
   */
  shots: ColdOpenShot[]
}


// The client's Podcast Cold Open Finder spec, used verbatim as the system prompt.
const SYSTEM_PROMPT = `You are an expert YouTube video editor and retention strategist. Your job is to analyze the following podcast transcript and extract exactly 3 options for a 30-second "Cold Open" hook.

## Strict Selection Criteria (The Evals)
For a segment to be selected, it MUST pass the following evaluation checks:
1. The 3-Second Rule: The very first sentence must contain a high-impact hook word or concept (e.g., "I never told anyone...", "The biggest mistake...", "We lost everything"). No pleasantries, no "So, tell me about...".
2. Context Independence: The clip must make emotional or conceptual sense to a stranger who has zero context about the guest or host.
3. The 25-Second Cutoff: The narrative arc or high-stakes statement must reach a natural cliffhanger or punchline between the 20 and 30-second mark.
4. Visual Potential: The text must imply dynamic facial expressions, high emotion, or intense delivery (avoid flat, academic explanations).

## Banned Elements (Auto-Fail Filter)
Immediately disqualify any segment that:
- Starts with the host introducing the guest.
- Uses industry jargon that requires a 2-minute explanation.
- Ends on a flat note, or trails off into "um" and "uh" (unless it signifies deep emotion).
- Exceeds 75 words (approx. 30 seconds of rapid speech).

## Input
Each transcript line is prefixed with its start time in seconds: "[123.4] spoken text". Use these timestamps to set startSeconds and endSeconds for each option (startSeconds = the bracket time of the first line of the clip; endSeconds = roughly 20-30 seconds later, at the cliffhanger).

## Energy Reset Shot List
For each option also produce an internal cut plan following the "Energy Reset" visual pacing pattern. The rule: no single camera angle sits for longer than 3–4 seconds during the hook. Use three camera types:
- "guest_tight": tight close-up single on the speaking guest
- "host_reaction": cut to host's face while guest audio continues underneath
- "wide": studio/establishing wide shot

Follow this template pattern (adjust offsets to match natural speech breaks in the transcript):
- 0:00 → guest_tight (hook line delivery)
- 0:03 → host_reaction (silent — guest audio continues)
- 0:07 → wide (establish the space)
- 0:10 → guest_tight (return, but re-engaging)
- 0:15 → host_reaction (as tension builds)
- 0:20 → guest_tight (climax/cliffhanger delivery)

Adjust break points to land on natural sentence boundaries in the transcript. If the window is under 15 seconds, omit the host_reaction and wide cuts and just use guest_tight.

## Digital Punch-Ins
Mark 1–2 shots per option with "punch": true where the speaker delivers a high-impact word or emotional peak. The tool will scale that clip from 100% to 103% across its duration (subtle zoom-in). Only mark genuinely emphatic moments — overuse kills the effect.

## J/L Split Edits (use sparingly, max 2 per clip)
- For the opening cut: set "jCutSeconds": 1.5 on the first shot if the guest's audio energy warrants bringing audio in before the visual — creates anticipation.
- For the closing cliffhanger shot: set "lCutSeconds": 1.0 on the last shot if the audio trailing into black adds tension.
- Leave both fields absent (or 0) for all other shots.

## Output Format (STRICT)
Respond with ONLY a raw JSON object — no prose, no markdown fences — of exactly this shape:
{"options":[{"startSeconds":<number>,"endSeconds":<number>,"archetype":"<In Media Res|Open Loop|Paradigm Shift|...>","script":"<exact verbatim text to cut>","justification":"<why this keeps a YouTube viewer from clicking away in the first 5 seconds>","shots":[{"offsetSeconds":<number>,"shot":"<guest_tight|host_reaction|wide>","note":"<optional editor hint>","punch":false,"jCutSeconds":0,"lCutSeconds":0}]}]}
Provide exactly 3 options, best first. Each option must include a shots array.`

const VALID_SHOT_TYPES = new Set(['guest_tight', 'host_reaction', 'wide'])

function extractOptions(text: string): ColdOpenOption[] {
  let raw = text.trim()
  // Strip markdown fences if the model added them despite instructions.
  raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  // Fall back to the outermost object if there is surrounding prose.
  if (!raw.startsWith('{')) {
    const first = raw.indexOf('{')
    const last = raw.lastIndexOf('}')
    if (first === -1 || last === -1) throw new Error('Claude did not return JSON.')
    raw = raw.slice(first, last + 1)
  }
  const parsed = JSON.parse(raw) as { options?: unknown }
  if (!parsed.options || !Array.isArray(parsed.options)) throw new Error('Claude response had no options array.')
  return parsed.options.map((o) => {
    const opt = o as Record<string, unknown>
    const rawShots = Array.isArray(opt.shots) ? opt.shots : []
    const shots: ColdOpenShot[] = rawShots
      .map((s) => {
        const sh = s as Record<string, unknown>
        const shotType = String(sh.shot ?? 'guest_tight')
        return {
          offsetSeconds: Number(sh.offsetSeconds) || 0,
          shot: (VALID_SHOT_TYPES.has(shotType) ? shotType : 'guest_tight') as ColdOpenShot['shot'],
          note: sh.note ? String(sh.note) : undefined,
          punch: sh.punch === true,
          jCutSeconds: Number(sh.jCutSeconds) || 0,
          lCutSeconds: Number(sh.lCutSeconds) || 0,
        }
      })
      .filter((s) => s.offsetSeconds >= 0)
      .sort((a, b) => a.offsetSeconds - b.offsetSeconds)
    return {
      startSeconds: Number(opt.startSeconds) || 0,
      endSeconds: Number(opt.endSeconds) || 0,
      archetype: String(opt.archetype ?? 'Hook'),
      script: String(opt.script ?? ''),
      justification: String(opt.justification ?? ''),
      shots,
    }
  })
}

/**
 * Send the transcript to Claude and return 3 ranked cold-open options.
 * Raw HTTP (not the SDK) because this runs inside Premiere's UXP runtime, which
 * bundles a constrained, browser-like environment; the dangerous-direct-browser
 * header is required for the API to accept a direct client-side request.
 */
export async function findColdOpens(transcript: TranscriptSegment[], apiKey: string): Promise<ColdOpenOption[]> {
  if (!apiKey) throw new Error('Add your Anthropic API key first.')
  if (!transcript.length) throw new Error('No transcript to analyze.')

  const lines = [...transcript]
    .sort((a, b) => a.start - b.start)
    .map((s) => `[${s.start.toFixed(1)}] ${s.text}`)
    .join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: claudeModel().id,
      // Thinking counts towards max_tokens on current models, so leave room for it.
      max_tokens: 16000,
      output_config: { effort: claudeModel().effort },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Transcript:\n\n${lines}` }],
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 401) throw new Error('Anthropic rejected the API key (401). Check it and try again.')
    throw new Error(`Claude API error ${res.status}. ${body.slice(0, 300)}`)
  }

  const data = await res.json() as { content?: { type: string; text?: string }[]; stop_reason?: string }
  if (data.stop_reason === 'refusal') throw new Error('Claude declined to read this transcript.')
  if (data.stop_reason === 'max_tokens') throw new Error("Claude's answer was cut off. Try again, or switch to Sonnet in Setup.")
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  if (!text) throw new Error('Claude returned an empty response.')
  return extractOptions(text)
}
