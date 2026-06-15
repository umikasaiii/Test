import { Menu, Bell, HardHat } from 'lucide-react'
import { useApp } from '../../context/AppContext'

interface Props {
  onMenuClick: () => void
  title: string
}

export default function Header({ onMenuClick, title }: Props) {
  const { state } = useApp()

  const overdueInvoices = state.invoices.filter(i => i.status === 'scaduta').length
  const lowStock = state.materials.filter(m => m.stock <= m.minStock).length
  const alerts = overdueInvoices + lowStock

  return (
    <header className="bg-white border-b border-gray-200 h-16 flex items-center justify-between px-4 lg:px-6 sticky top-0 z-10 flex-shrink-0">
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="lg:hidden p-2 rounded-lg hover:bg-gray-100 text-gray-600"
        >
          <Menu size={20} />
        </button>
        <h1 className="text-lg font-semibold text-gray-800">{title}</h1>
      </div>

      <div className="flex items-center gap-3">
        {alerts > 0 && (
          <div className="relative">
            <Bell size={20} className="text-gray-500" />
            <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center font-bold">
              {alerts}
            </span>
          </div>
        )}
        <div className="flex items-center gap-2 bg-gray-100 rounded-full px-3 py-1.5">
          <div className="bg-orange-500 rounded-full p-1">
            <HardHat size={14} className="text-white" />
          </div>
          <span className="text-sm font-medium text-gray-700 hidden sm:block">Admin</span>
        </div>
      </div>
    </header>
  )
}
