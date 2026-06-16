import { HardHat, Bell } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { InstallButton } from '../ui/InstallPrompt'

export default function HeroSection() {
  const { state } = useApp()

  const overdueInvoices = state.invoices.filter(i => i.status === 'scaduta').length
  const lowStock = state.materials.filter(m => m.stock <= m.minStock).length
  const alerts = overdueInvoices + lowStock

  const today = new Date()
  const dateStr = today.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const dateCapitalized = dateStr.charAt(0).toUpperCase() + dateStr.slice(1)

  return (
    <header
      className="relative overflow-hidden px-4 pt-6 pb-8"
      style={{
        background: 'linear-gradient(135deg, rgba(245,130,32,.96) 0%, rgba(255,169,77,.92) 60%, rgba(251,146,60,.88) 100%)',
        boxShadow: '0 14px 34px rgba(180,90,20,.22)'
      }}
    >
      {/* decorative blob */}
      <div className="pointer-events-none absolute right-6 top-3 text-8xl opacity-10 rotate-[-14deg] select-none">🏗️</div>
      <div className="pointer-events-none absolute inset-0"
        style={{ background: 'linear-gradient(90deg,rgba(74,44,26,.22),rgba(74,44,26,.03))' }} />

      <div className="relative z-10 max-w-7xl mx-auto flex items-end justify-between gap-4">
        {/* left: logo + name */}
        <div className="flex items-end gap-3">
          <div className="bg-white/20 backdrop-blur-sm rounded-2xl p-2.5 border border-white/30">
            <HardHat size={28} className="text-white" />
          </div>
          <div>
            <p className="text-white/70 text-xs font-bold tracking-widest uppercase">Gestionale</p>
            <h1 className="text-white font-black leading-none tracking-tight"
              style={{ fontSize: 'clamp(2rem,6vw,3.5rem)', textShadow: '0 8px 24px rgba(0,0,0,.18)' }}>
              EdilGestionale
            </h1>
          </div>
        </div>

        {/* right: date + alerts + install */}
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <InstallButton />

            {alerts > 0 && (
              <div className="relative flex items-center gap-1.5 bg-white/20 backdrop-blur-sm border border-white/30 rounded-full px-3 py-1.5">
                <Bell size={14} className="text-white" />
                <span className="text-white text-xs font-bold">{alerts}</span>
              </div>
            )}
          </div>
          <div className="bg-white/18 backdrop-blur-sm border border-white/28 rounded-full px-3 py-1.5">
            <span className="text-white text-xs font-bold">{dateCapitalized}</span>
          </div>
        </div>
      </div>
    </header>
  )
}
