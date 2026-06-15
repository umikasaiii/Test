import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, FolderKanban, Users, Package, FileText,
  Receipt, Building2, Truck, ClipboardList, BarChart3, X, HardHat
} from 'lucide-react'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/progetti', icon: FolderKanban, label: 'Progetti' },
  { to: '/attivita', icon: ClipboardList, label: 'Attività' },
  { to: '/operai', icon: Users, label: 'Operai & Presenze' },
  { to: '/clienti', icon: Building2, label: 'Clienti' },
  { to: '/fornitori', icon: Truck, label: 'Fornitori' },
  { to: '/materiali', icon: Package, label: 'Magazzino' },
  { to: '/fatture', icon: Receipt, label: 'Fatture' },
  { to: '/spese', icon: FileText, label: 'Spese' },
  { to: '/documenti', icon: ClipboardList, label: 'Documenti' },
  { to: '/report', icon: BarChart3, label: 'Report & Analisi' },
]

interface Props {
  open: boolean
  onClose: () => void
}

export default function Sidebar({ open, onClose }: Props) {
  return (
    <>
      {open && (
        <div className="fixed inset-0 bg-black/50 z-20 lg:hidden" onClick={onClose} />
      )}
      <aside className={`
        fixed top-0 left-0 h-full w-64 bg-gray-900 text-white z-30 flex flex-col
        transform transition-transform duration-300
        ${open ? 'translate-x-0' : '-translate-x-full'}
        lg:translate-x-0 lg:static lg:h-screen lg:flex-shrink-0
      `}>
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <div className="bg-orange-500 p-2 rounded-lg">
              <HardHat size={20} className="text-white" />
            </div>
            <div>
              <p className="font-bold text-sm leading-tight">EdilGestionale</p>
              <p className="text-gray-400 text-xs">Impresa Edile Pro</p>
            </div>
          </div>
          <button onClick={onClose} className="lg:hidden text-gray-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-4">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => window.innerWidth < 1024 && onClose()}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                  isActive
                    ? 'bg-orange-500 text-white'
                    : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                }`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-700 text-xs text-gray-500 text-center">
          v1.0.0 &copy; 2024 EdilGestionale
        </div>
      </aside>
    </>
  )
}
