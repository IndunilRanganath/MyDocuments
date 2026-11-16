'use client';
import { Delete, LockKeyhole } from 'lucide-react';
export function PinPad({ value, onChange, disabled, label = 'Six-digit PIN' }: { value: string; onChange: (v: string) => void; disabled?: boolean; label?: string }) {
  return <div className="pin-pad">
    <div className="pin-entry">
      <div className="pin-dots" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <span className={i < value.length ? 'filled' : ''} key={i} />)}</div>
      <input aria-label={label} type="password" inputMode="numeric" autoComplete="off" maxLength={6} pattern="[0-9]{6}" value={value} disabled={disabled} onChange={e => onChange(e.target.value.replace(/\D/g, '').slice(0,6))} />
    </div>
    <div className="keypad">{[1,2,3,4,5,6,7,8,9].map(n => <button type="button" disabled={disabled} key={n} onClick={() => value.length < 6 && onChange(value + n)}>{n}</button>)}
      <span className="keypad-lock"><LockKeyhole size={18} strokeWidth={1.5}/></span>
      <button type="button" disabled={disabled} onClick={() => value.length < 6 && onChange(value + '0')}>0</button>
      <button type="button" aria-label="Delete last digit" disabled={disabled || !value} onClick={() => onChange(value.slice(0,-1))}><Delete size={23} strokeWidth={1.5}/></button>
    </div>
  </div>;
}
