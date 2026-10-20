import type { CSSProperties, ReactNode } from 'react'

export function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return <span className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} tabIndex={0} onClick={onChange}><span className="toggle-knob" /></span>
}

// UXP paints native chrome over <button> backgrounds, so render clickables as styleable spans.
export function Press({ className = '', onClick, disabled = false, style, children }: { className?: string; onClick?: () => void; disabled?: boolean; style?: CSSProperties; children: ReactNode }) {
  return <span role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} className={`${className}${disabled ? ' is-disabled' : ''}`} style={style} onClick={() => { if (!disabled) onClick?.() }}>{children}</span>
}
