import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import Header from './Header'
import BottomNav from './BottomNav'
import InstallPrompt from '../ui/InstallPrompt'

const pageTitles: Record<string, string> = {
  '/': 'Dashboard',
  '/progetti': 'Gestione Progetti',
  '/attivita': 'Attività & Task',
  '/operai': 'Operai & Presenze',
  '/clienti': 'Clienti',
  '/fornitori': 'Fornitori',
  '/materiali': 'Magazzino Materiali',
  '/fatture': 'Fatture',
  '/spese': 'Spese',
  '/documenti': 'Documenti',
  '/report': 'Report & Analisi',
  '/calendario': 'Calendario',
  '/rendering': 'Prima & Dopo',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()
  const title = pageTitles[location.pathname] || 'EdilGestionale'

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <Header onMenuClick={() => setSidebarOpen(true)} title={title} />

        {/* Extra padding bottom on mobile for BottomNav */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6 pb-20 lg:pb-6">
          {children}
        </main>
      </div>

      <BottomNav onMenuClick={() => setSidebarOpen(true)} />
      <InstallPrompt />
    </div>
  )
}
