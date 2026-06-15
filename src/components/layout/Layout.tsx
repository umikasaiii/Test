import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import Header from './Header'

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
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
