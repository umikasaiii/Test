interface Props {
  title: string
  value: string | number
  subtitle?: string
  icon: React.ReactNode
  color?: string
  trend?: { value: number; label: string }
}

export default function StatCard({ title, value, subtitle, icon, color = 'bg-orange-500', trend }: Props) {
  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm text-gray-500 font-medium">{title}</p>
          <p className="text-2xl font-bold text-gray-800 mt-1">{value}</p>
          {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
          {trend && (
            <p className={`text-xs mt-1 font-medium ${trend.value >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {trend.value >= 0 ? '+' : ''}{trend.value}% {trend.label}
            </p>
          )}
        </div>
        <div className={`${color} p-3 rounded-xl text-white flex-shrink-0`}>
          {icon}
        </div>
      </div>
    </div>
  )
}
