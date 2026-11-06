/** 基础控件，保证全应用只有一种写法。样式仍由 index.css 定义，组件只负责结构。 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

/* ---------------- Button ---------------- */

type ButtonVariant = 'dark' | 'ghost' | 'soft'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
}

export function Button({ variant = 'dark', className = '', type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`btn btn-${variant}${className ? ` ${className}` : ''}`} {...rest} />
}

/* ---------------- Switch ---------------- */

type SwitchProps = {
  checked: boolean
  onChange: () => void
  /** 无障碍名称，必填 */
  label: string
  disabled?: boolean
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      className={`switch${checked ? ' is-on' : ''}`}
      onClick={onChange}
      aria-label={label}
      aria-pressed={checked}
      disabled={disabled}
    >
      <i />
    </button>
  )
}

/* ---------------- Stepper ---------------- */

type StepperProps = {
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  onChange: (next: number) => void
  /** 中间显示的内容，不传就显示 value */
  children?: ReactNode
}

export function Stepper({ value, min, max, step = 1, disabled, onChange, children }: StepperProps) {
  return (
    <div className={`stepper${disabled ? ' is-off' : ''}`}>
      <button
        type="button"
        className="step"
        disabled={disabled || value <= min}
        onClick={() => onChange(Math.max(min, value - step))}
      >
        −
      </button>
      <b className="pref-num">{children ?? value}</b>
      <button
        type="button"
        className="step"
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + step))}
      >
        +
      </button>
    </div>
  )
}
