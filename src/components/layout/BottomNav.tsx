import { NavLink } from 'react-router-dom'
import { LayoutDashboard, FolderKanban, Users, Receipt, BarChart3, Settings } from 'lucide-react'

const quickItems = [
  { to: '/', icon: LayoutDashboard, label: 'Home' },
  { to: '/progetti', icon: FolderKanban, label: 'Progetti' },
  { to: '/operai', icon: Users, label: 'Operai' },
  { to: '/fatture', icon: Receipt, label: 'Fatture' },
  { to: '/report', icon: BarChart3, label: 'Report' },
  { to: '/impostazioni', icon: Settings, label: 'Impostazioni' },
]

export default function BottomNav() {
  return (
    <nav
      className="lg:hidden fixed bottom-0 left-0 right-0 z-20 flex items-center"
      style={{
        background: 'rgba(255,250,241,.95)',
        backdropFilter: 'blur(16px)',
        borderTop: '1px solid rgba(245,130,32,.18)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        boxShadow: '0 -8px 24px rgba(180,100,30,.10)'
      }}
    >
      {quickItems.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center justify-center py-2 text-xs gap-1 transition-colors ${
              isActive ? 'text-orange-500' : 'text-orange-800/50'
            }`
          }
        >
          <Icon size={20} />
          <span className="leading-none">{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
