import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppProvider } from './context/AppContext'
import Layout from './components/layout/Layout'
import Dashboard from './pages/Dashboard'
import Progetti from './pages/Progetti'
import Attivita from './pages/Attivita'
import Operai from './pages/Operai'
import Clienti from './pages/Clienti'
import Fornitori from './pages/Fornitori'
import Materiali from './pages/Materiali'
import Fatture from './pages/Fatture'
import Spese from './pages/Spese'
import Documenti from './pages/Documenti'
import Report from './pages/Report'

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/progetti" element={<Progetti />} />
            <Route path="/attivita" element={<Attivita />} />
            <Route path="/operai" element={<Operai />} />
            <Route path="/clienti" element={<Clienti />} />
            <Route path="/fornitori" element={<Fornitori />} />
            <Route path="/materiali" element={<Materiali />} />
            <Route path="/fatture" element={<Fatture />} />
            <Route path="/spese" element={<Spese />} />
            <Route path="/documenti" element={<Documenti />} />
            <Route path="/report" element={<Report />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </AppProvider>
  )
}
