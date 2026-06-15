import { NavLink } from 'react-router-dom'
import { LayoutDashboard, FolderKanban, Users, Receipt, BarChart3, Menu } from 'lucide-react'

const quickItems = [
  { to: '/', icon: LayoutDashboard, label: 'Home' },
  { to: '/progetti', icon: FolderKanban, label: 'Progetti' },
  { to: '/operai', icon: Users, label: 'Operai' },
  { to: '/fatture', icon: Receipt, label: 'Fatture' },
  { to: '/report', icon: BarChart3, label: 'Report' },
]

interface Props {
  onMenuClick: () => void
}

export default function BottomNav({ onMenuClick }: Props) {
  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-20 bg-white border-t border-gray-200 flex items-center"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {quickItems.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center justify-center py-2 text-xs gap-1 transition-colors ${
              isActive ? 'text-orange-500' : 'text-gray-400'
            }`
          }
        >
          <Icon size={20} />
          <span className="leading-none">{label}</span>
        </NavLink>
      ))}
      <button
        onClick={onMenuClick}
        className="flex-1 flex flex-col items-center justify-center py-2 text-xs gap-1 text-gray-400"
      >
        <Menu size={20} />
        <span className="leading-none">Altro</span>
      </button>
    </nav>
  )
}
