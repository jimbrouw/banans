import type { TranscriptSegment } from './types'

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
}

const MODEL = 'claude-opus-4-8'

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

## Output Format (STRICT)
Respond with ONLY a raw JSON object — no prose, no markdown fences — of exactly this shape:
{"options":[{"startSeconds":<number>,"endSeconds":<number>,"archetype":"<In Media Res|Open Loop|Paradigm Shift|...>","script":"<exact verbatim text to cut>","justification":"<why this keeps a YouTube viewer from clicking away in the first 5 seconds>"}]}
Provide exactly 3 options, best first.`

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
    return {
      startSeconds: Number(opt.startSeconds) || 0,
      endSeconds: Number(opt.endSeconds) || 0,
      archetype: String(opt.archetype ?? 'Hook'),
      script: String(opt.script ?? ''),
      justification: String(opt.justification ?? ''),
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
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Transcript:\n\n${lines}` }],
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 401) throw new Error('Anthropic rejected the API key (401). Check it and try again.')
    throw new Error(`Claude API error ${res.status}. ${body.slice(0, 300)}`)
  }

  const data = await res.json() as { content?: { type: string; text?: string }[] }
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  if (!text) throw new Error('Claude returned an empty response.')
  return extractOptions(text)
}
