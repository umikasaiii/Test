import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, FolderKanban, Users, Package, FileText,
  Receipt, Building2, Truck, ClipboardList, BarChart3, X, HardHat,
  CalendarDays, ImagePlay
} from 'lucide-react'

const navGroups = [
  {
    label: 'Principale',
    items: [
      { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
      { to: '/progetti', icon: FolderKanban, label: 'Progetti' },
      { to: '/attivita', icon: ClipboardList, label: 'Attività' },
      { to: '/calendario', icon: CalendarDays, label: 'Calendario' },
    ],
  },
  {
    label: 'Risorse',
    items: [
      { to: '/operai', icon: Users, label: 'Operai & Presenze' },
      { to: '/clienti', icon: Building2, label: 'Clienti' },
      { to: '/fornitori', icon: Truck, label: 'Fornitori' },
      { to: '/materiali', icon: Package, label: 'Magazzino' },
    ],
  },
  {
    label: 'Contabilità',
    items: [
      { to: '/fatture', icon: Receipt, label: 'Fatture' },
      { to: '/spese', icon: FileText, label: 'Spese' },
      { to: '/documenti', icon: ClipboardList, label: 'Documenti' },
    ],
  },
  {
    label: 'Analisi',
    items: [
      { to: '/rendering', icon: ImagePlay, label: 'Prima & Dopo' },
      { to: '/report', icon: BarChart3, label: 'Report & Analisi' },
    ],
  },
]

interface Props {
  open: boolean
  onClose: () => void
}

export default function Sidebar({ open, onClose }: Props) {
  return (
    <>
      {open && (
        <div className="fixed inset-0 bg-black/60 z-20 lg:hidden" onClick={onClose} />
      )}
      <aside className={`
        fixed top-0 left-0 h-full w-64 bg-gray-900 text-white z-30 flex flex-col
        transform transition-transform duration-300
        ${open ? 'translate-x-0' : '-translate-x-full'}
        lg:translate-x-0 lg:static lg:h-screen lg:flex-shrink-0
      `} style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="flex items-center justify-between p-4 border-b border-gray-700 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="bg-orange-500 p-2 rounded-lg">
              <HardHat size={20} className="text-white" />
            </div>
            <div>
              <p className="font-bold text-sm leading-tight">EdilGestionale</p>
              <p className="text-gray-400 text-xs">Impresa Edile Pro</p>
            </div>
          </div>
          <button onClick={onClose} className="lg:hidden text-gray-400 hover:text-white p-1">
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-3">
          {navGroups.map(group => (
            <div key={group.label} className="mb-2">
              <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-4 py-2">{group.label}</p>
              {group.items.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/'}
                  onClick={() => window.innerWidth < 1024 && onClose()}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-4 py-2.5 text-sm transition-colors mx-2 rounded-lg ${
                      isActive
                        ? 'bg-orange-500 text-white'
                        : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                    }`
                  }
                >
                  <Icon size={17} />
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-700 text-xs text-gray-500 text-center flex-shrink-0">
          v1.1.0 &copy; 2024 EdilGestionale
        </div>
      </aside>
    </>
  )
}
