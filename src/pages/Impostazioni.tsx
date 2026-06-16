import { useState, useEffect } from 'react'
import { Download, Smartphone, Info, HardHat, Wifi, WifiOff, CheckCircle } from 'lucide-react'
import { triggerInstall } from '../components/ui/InstallPrompt'

function useInstallState() {
  const [canInstall, setCanInstall] = useState(false)
  const [isInstalled, setIsInstalled] = useState(false)
  const [isIOS, setIsIOS] = useState(false)

  useEffect(() => {
    if (window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone) {
      setIsInstalled(true)
      return
    }
    if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
      setIsIOS(true)
      setCanInstall(true)
      return
    }
    const interval = setInterval(() => {
      setCanInstall(!!triggerInstall)
    }, 300)
    return () => clearInterval(interval)
  }, [])

  return { canInstall, isInstalled, isIOS }
}

export default function Impostazioni() {
  const { canInstall, isInstalled, isIOS } = useInstallState()
  const [showIOSSteps, setShowIOSSteps] = useState(false)
  const [isOnline, setIsOnline] = useState(navigator.onLine)

  useEffect(() => {
    const on = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  function handleInstall() {
    if (isIOS) { setShowIOSSteps(true); return }
    if (triggerInstall) triggerInstall()
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5">

      {/* Install app card — the main request */}
      <div className="rounded-3xl overflow-hidden shadow-xl"
        style={{ background: 'linear-gradient(135deg,#F58220,#FF9A3D)', boxShadow: '0 18px 42px rgba(245,130,32,.35)' }}>
        <div className="p-6 text-white relative overflow-hidden">
          <div className="pointer-events-none absolute right-4 top-2 text-7xl opacity-10 select-none">📱</div>
          <div className="relative z-10">
            <p className="text-white/70 text-xs font-bold uppercase tracking-widest mb-1">Progressive Web App</p>
            <h2 className="text-2xl font-black mb-2">Installa l'app</h2>
            <p className="text-white/80 text-sm mb-5">
              Aggiungi EdilGestionale alla schermata Home per accedervi come una vera app, anche offline.
            </p>

            {isInstalled ? (
              <div className="flex items-center gap-3 bg-white/20 rounded-2xl px-4 py-3 backdrop-blur-sm border border-white/30">
                <CheckCircle size={22} className="text-white flex-shrink-0" />
                <div>
                  <p className="font-bold text-sm">App già installata</p>
                  <p className="text-white/70 text-xs">Stai usando EdilGestionale in modalità app</p>
                </div>
              </div>
            ) : canInstall ? (
              <button
                onClick={handleInstall}
                className="flex items-center gap-2 bg-white text-orange-600 font-black px-6 py-3.5 rounded-2xl text-sm shadow-lg hover:shadow-xl transition-all hover:-translate-y-0.5 active:translate-y-0"
              >
                <Download size={18} />
                {isIOS ? 'Vedi istruzioni per iPhone/iPad' : 'Installa ora su questo dispositivo'}
              </button>
            ) : (
              <div className="flex items-start gap-3 bg-white/15 rounded-2xl px-4 py-3 backdrop-blur-sm border border-white/25">
                <Smartphone size={20} className="text-white flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-sm">Installazione non disponibile</p>
                  <p className="text-white/75 text-xs mt-0.5">
                    Apri questa pagina in Chrome (Android) o Safari (iPhone) per installare l'app.
                    Su Chrome: menu ⋮ → "Aggiungi a schermata Home".
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* iOS step-by-step */}
        {showIOSSteps && (
          <div className="bg-white/10 backdrop-blur-sm border-t border-white/20 p-5">
            <p className="text-white font-bold text-sm mb-3">Come installare su iPhone/iPad:</p>
            <div className="space-y-2.5">
              {[
                { n: 1, icon: '⬆️', text: 'Tocca il pulsante Condividi nella barra del browser Safari' },
                { n: 2, icon: '➕', text: 'Scorri l\'elenco e tocca "Aggiungi a schermata Home"' },
                { n: 3, icon: '✅', text: 'Tocca "Aggiungi" in alto a destra per confermare' },
              ].map(s => (
                <div key={s.n} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-white/25 border border-white/40 flex items-center justify-center text-xs font-black text-white flex-shrink-0">{s.n}</div>
                  <p className="text-white/90 text-sm">{s.icon} {s.text}</p>
                </div>
              ))}
            </div>
            <button onClick={() => setShowIOSSteps(false)} className="mt-4 text-white/70 text-xs underline">Chiudi</button>
          </div>
        )}
      </div>

      {/* App info */}
      <div className="bg-white/80 backdrop-blur-sm rounded-3xl border border-orange-100 shadow-md p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="bg-orange-500 rounded-xl p-2.5">
            <HardHat size={22} className="text-white" />
          </div>
          <div>
            <h3 className="font-black text-gray-800">EdilGestionale</h3>
            <p className="text-gray-500 text-xs">Gestionale professionale per imprese edili</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Versione', value: '1.1.0' },
            { label: 'Tipo', value: 'PWA Offline' },
            { label: 'Dati', value: 'Locali (no cloud)' },
            { label: 'Licenza', value: '© 2024 EdilGestionale' },
          ].map(({ label, value }) => (
            <div key={label} className="bg-orange-50 rounded-2xl px-3 py-2.5 border border-orange-100">
              <p className="text-orange-700 text-xs font-bold">{label}</p>
              <p className="text-gray-700 text-sm font-semibold mt-0.5">{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Connection status */}
      <div className={`rounded-3xl border p-4 flex items-center gap-3 ${
        isOnline
          ? 'bg-green-50 border-green-200'
          : 'bg-red-50 border-red-200'
      }`}>
        {isOnline
          ? <Wifi size={20} className="text-green-600 flex-shrink-0" />
          : <WifiOff size={20} className="text-red-500 flex-shrink-0" />
        }
        <div>
          <p className={`font-bold text-sm ${isOnline ? 'text-green-700' : 'text-red-600'}`}>
            {isOnline ? 'Connesso a Internet' : 'Modalità offline'}
          </p>
          <p className={`text-xs ${isOnline ? 'text-green-600' : 'text-red-500'}`}>
            {isOnline
              ? 'Tutti i dati vengono salvati localmente sul dispositivo'
              : 'L\'app funziona ugualmente — i dati sono salvati localmente'
            }
          </p>
        </div>
      </div>

      {/* Feature list */}
      <div className="bg-white/80 backdrop-blur-sm rounded-3xl border border-orange-100 shadow-md p-5">
        <div className="flex items-center gap-2 mb-4">
          <Info size={18} className="text-orange-500" />
          <h3 className="font-black text-gray-800">Funzionalità incluse</h3>
        </div>
        <div className="grid grid-cols-1 gap-2">
          {[
            '🏗️ Gestione progetti con avanzamento e budget',
            '✅ Task e attività con kanban board',
            '👷 Operai, presenze e certificazioni',
            '🏢 Anagrafica clienti e fornitori',
            '📦 Magazzino materiali con ordini',
            '💶 Fatture con calcolo IVA e stampa PDF',
            '💸 Gestione spese e approvazioni',
            '📄 Archivio documenti con alert scadenze',
            '📅 Calendario appuntamenti',
            '📸 Report prima & dopo con foto',
            '📊 Report e grafici analitici',
            '📲 Installabile come app (PWA)',
            '🔌 Funziona offline — dati sempre disponibili',
          ].map(f => (
            <div key={f} className="text-sm text-gray-700 py-1.5 border-b border-orange-50 last:border-0">
              {f}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
