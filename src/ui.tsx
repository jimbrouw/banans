import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

export function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return <span className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} tabIndex={0} onClick={onChange}><span className="toggle-knob" /></span>
}

// UXP paints native chrome over <button> backgrounds, so render clickables as styleable spans.
export function Press({ className = '', onClick, disabled = false, style, children }: { className?: string; onClick?: () => void; disabled?: boolean; style?: CSSProperties; children: ReactNode }) {
  return <span role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} className={`${className}${disabled ? ' is-disabled' : ''}`} style={style} onClick={() => { if (!disabled) onClick?.() }}>{children}</span>
}

/** Settings that most runs don't need, folded away under one line. */
export function Options({ label = 'Options', summary, children }: { label?: string; summary?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`options ${open ? 'open' : ''}`}>
      <Press className="options-toggle" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={14} className="options-chevron" />{label}{!open && summary && <small>{summary}</small>}
      </Press>
      {open && <div className="options-body">{children}</div>}
    </div>
  )
}
