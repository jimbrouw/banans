// Small per-machine settings kept in the panel's localStorage.
// The Claude key is entered once (Setup tab) and used by every AI feature.

export const SETTINGS = {
  claudeKey: 'roughcut.anthropicKey',
  aiProvider: 'roughcut.aiProvider',
  tab: 'roughcut.tab',
} as const

export function readSetting(key: string, fallback = ''): string {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}

export function writeSetting(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* localStorage unavailable */ }
}

export const NO_CLAUDE_KEY = 'Add your Claude API key in the Setup tab first.'
