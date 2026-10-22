// Small per-machine settings kept in the panel's localStorage.
// The Claude key is entered once (Setup tab) and used by every AI feature.

export const SETTINGS = {
  claudeKey: 'roughcut.anthropicKey',
  tab: 'roughcut.tab',
  claudeModel: 'roughcut.claudeModel',
} as const

// Cost: Claude Sonnet at low effort (the default: it found the editor's Short in the eval) or Haiku at high effort. Never Opus.
export const CLAUDE_MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (best picks, about 35¢ an episode)', effort: 'low' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (cheapest, about 3¢ an episode)', effort: 'high' },
] as const
export type ClaudeModel = (typeof CLAUDE_MODELS)[number]

/** The chosen Claude model, falling back to Sonnet for anything not on the list. */
export function claudeModel(): ClaudeModel {
  const id = readSetting(SETTINGS.claudeModel, CLAUDE_MODELS[0].id)
  return CLAUDE_MODELS.find((m) => m.id === id) ?? CLAUDE_MODELS[0]
}

export function readSetting(key: string, fallback = ''): string {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}

export function writeSetting(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* localStorage unavailable */ }
}

export const NO_CLAUDE_KEY = 'Add your Claude API key in the Setup tab first.'
