import { NavLink } from 'react-router-dom'

const navItems = [
  { to: '/', label: '🏠 Dashboard' },
  { to: '/progetti', label: '📐 Progetti' },
  { to: '/attivita', label: '✅ Attività' },
  { to: '/calendario', label: '📅 Calendario' },
  { to: '/operai', label: '👷 Operai' },
  { to: '/clienti', label: '🏢 Clienti' },
  { to: '/fornitori', label: '🚛 Fornitori' },
  { to: '/materiali', label: '📦 Magazzino' },
  { to: '/fatture', label: '💶 Fatture' },
  { to: '/spese', label: '💸 Spese' },
  { to: '/documenti', label: '📄 Documenti' },
  { to: '/rendering', label: '📸 Prima & Dopo' },
  { to: '/report', label: '📊 Report' },
  { to: '/impostazioni', label: '⚙️ Impostazioni' },
]

export default function TopNav() {
  return (
    <div
      className="sticky top-0 z-40 px-3 pt-2 pb-3"
      style={{ background: 'linear-gradient(180deg,rgba(255,243,226,.97),rgba(255,236,205,.82))', backdropFilter: 'blur(16px)' }}
    >
      <div className="max-w-7xl mx-auto">
        <div
          className="flex gap-1.5 overflow-x-auto scrollbar-hide px-1.5 py-1.5 rounded-3xl border border-orange-200/60"
          style={{ background: 'rgba(255,253,248,.65)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.4), 0 8px 24px rgba(180,100,30,.07)' }}
        >
          {navItems.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex-shrink-0 px-3.5 py-2 rounded-2xl text-xs font-bold transition-all whitespace-nowrap ${
                  isActive
                    ? 'bg-gradient-to-br from-orange-500 to-orange-600 text-white shadow-md shadow-orange-500/30'
                    : 'text-orange-900/60 hover:bg-orange-100/80 hover:text-orange-900'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </div>
      </div>
    </div>
  )
}
