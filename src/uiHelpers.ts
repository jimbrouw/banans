import { AlertTriangle, Camera, Film, Mic, Quote, Scissors, Sparkles } from 'lucide-react'
import { getRuntimeRequire } from './hostRuntime'
import type { MarkerType, Platform } from './types'

export const markerMeta: Record<MarkerType, { name: string; color: string; icon: typeof Sparkles }> = {
  social_clip: { name: 'Strong clip', color: '#69d59a', icon: Sparkles },
  chapter: { name: 'Chapter', color: '#58a9e8', icon: Film },
  suggested_trim: { name: 'Trim', color: '#ed7a13', icon: Scissors },
  warning: { name: 'Warning', color: '#e5bd53', icon: AlertTriangle },
  strong_quote: { name: 'Quote', color: '#f0a13b', icon: Quote },
  camera_switch: { name: 'Camera', color: '#52cbc7', icon: Camera },
  social_hook: { name: 'Hook', color: '#b57bed', icon: Sparkles },
  audiogram: { name: 'Audiogram', color: '#52cbc7', icon: Mic },
}

export const platformLabel: Record<Platform, string> = { shorts: 'YT', reels: 'IG', tiktok: 'TT', stories: 'Story', audiogram: 'Audio' }
export const platformColor: Record<Platform, string> = { shorts: '#c4302b', reels: '#c837ab', tiktok: '#00c8c8', stories: '#f77737', audiogram: '#52cbc7' }

// UXP doesn't navigate <a href>; open URLs through the shell (needs the
// launchProcess manifest permission), fall back to window.open in the browser.
export function openExternal(url: string) {
  try {
    const uxp = getRuntimeRequire()?.('uxp') as { shell?: { openExternal?: (u: string) => Promise<unknown> | void } } | undefined
    if (uxp?.shell?.openExternal) {
      Promise.resolve(uxp.shell.openExternal(url)).catch(() => { try { window.open(url, '_blank') } catch { /* no-op */ } })
      return
    }
  } catch { /* fall through to window.open */ }
  try { window.open(url, '_blank') } catch { /* no-op */ }
}

export const formatTime = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 19)
export const formatDuration = (start: number, end?: number) => { if (!end) return ''; const s = Math.round(end - start); return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s` }
export const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
