interface Props {
  label: string
  required?: boolean
  children: React.ReactNode
  hint?: string
}

export function FormField({ label, required, children, hint }: Props) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  )
}

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string
  required?: boolean
  hint?: string
}

export function Input({ label, required, hint, ...props }: InputProps) {
  return (
    <FormField label={label} required={required} hint={hint}>
      <input
        {...props}
        className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent ${props.className || ''}`}
      />
    </FormField>
  )
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label: string
  required?: boolean
  hint?: string
  options: { value: string; label: string }[]
}

export function Select({ label, required, hint, options, ...props }: SelectProps) {
  return (
    <FormField label={label} required={required} hint={hint}>
      <select
        {...props}
        className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent ${props.className || ''}`}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </FormField>
  )
}

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string
  required?: boolean
  hint?: string
}

export function Textarea({ label, required, hint, ...props }: TextareaProps) {
  return (
    <FormField label={label} required={required} hint={hint}>
      <textarea
        {...props}
        rows={props.rows || 3}
        className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent resize-y ${props.className || ''}`}
      />
    </FormField>
  )
}
