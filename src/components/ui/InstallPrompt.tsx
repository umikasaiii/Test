import { useState, useEffect } from 'react'
import { Download, X, Smartphone } from 'lucide-react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// Exported so Header can show an install button
export let triggerInstall: (() => void) | null = null

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [isIOS, setIsIOS] = useState(false)
  const [showIOSGuide, setShowIOSGuide] = useState(false)

  useEffect(() => {
    // Already installed as standalone?
    if (window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone) {
      setInstalled(true)
      return
    }

    // iOS detection
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
    if (ios) {
      setIsIOS(true)
      triggerInstall = () => setShowIOSGuide(true)
      return
    }

    // Android/Desktop: listen for browser event
    const handler = (e: Event) => {
      e.preventDefault()
      const prompt = e as BeforeInstallPromptEvent
      setDeferredPrompt(prompt)
      triggerInstall = async () => {
        await prompt.prompt()
        const { outcome } = await prompt.userChoice
        if (outcome === 'accepted') { setInstalled(true); setVisible(false) }
        setDeferredPrompt(null)
        triggerInstall = null
      }
      // Auto-show banner after 3 seconds if not dismissed before
      const dismissed = localStorage.getItem('pwa-banner-dismissed')
      if (!dismissed) setTimeout(() => setVisible(true), 3000)
    }

    window.addEventListener('beforeinstallprompt', handler)
    window.addEventListener('appinstalled', () => { setInstalled(true); setVisible(false) })
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  async function install() {
    if (triggerInstall) { triggerInstall(); return }
    if (deferredPrompt) {
      await deferredPrompt.prompt()
      const { outcome } = await deferredPrompt.userChoice
      if (outcome === 'accepted') setInstalled(true)
      setVisible(false)
    }
  }

  function dismiss() {
    setVisible(false)
    localStorage.setItem('pwa-banner-dismissed', '1')
  }

  if (installed) return null

  return (
    <>
      {/* Bottom banner (auto-show) */}
      {visible && !isIOS && (
        <div className="fixed bottom-20 lg:bottom-4 left-4 right-4 z-50 max-w-sm mx-auto animate-bounce-once">
          <div className="bg-gray-900 text-white rounded-2xl shadow-2xl p-4 flex items-start gap-3 border border-orange-500/40">
            <div className="bg-orange-500 rounded-xl p-2 flex-shrink-0">
              <Smartphone size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm">Installa EdilGestionale</p>
              <p className="text-xs text-gray-300 mt-0.5">Accedi offline, più veloce di un sito</p>
              <button
                onClick={install}
                className="mt-2 bg-orange-500 hover:bg-orange-600 text-white text-xs font-bold px-4 py-1.5 rounded-lg"
              >
                Installa ora
              </button>
            </div>
            <button onClick={dismiss} className="text-gray-500 hover:text-white p-1 flex-shrink-0">
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* iOS step-by-step guide modal */}
      {showIOSGuide && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-end justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-gray-800">Installa su iPhone/iPad</h3>
              <button onClick={() => setShowIOSGuide(false)} className="text-gray-400"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              {[
                { n: 1, icon: '⬆️', text: 'Tocca il pulsante Condividi nella barra del browser' },
                { n: 2, icon: '➕', text: 'Scorri e tocca "Aggiungi a schermata Home"' },
                { n: 3, icon: '✅', text: 'Tocca "Aggiungi" in alto a destra' },
              ].map(s => (
                <div key={s.n} className="flex items-start gap-3">
                  <div className="bg-orange-500 text-white rounded-full w-7 h-7 flex items-center justify-center text-sm font-bold flex-shrink-0">{s.n}</div>
                  <p className="text-sm text-gray-700"><span className="mr-1">{s.icon}</span>{s.text}</p>
                </div>
              ))}
            </div>
            <button onClick={() => setShowIOSGuide(false)} className="mt-5 w-full bg-orange-500 text-white font-bold py-2.5 rounded-xl text-sm">
              Ho capito
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// Floating install button shown in Header when banner not visible
export function InstallButton() {
  const [canInstall, setCanInstall] = useState(false)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    if (window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone) {
      setInstalled(true)
      return
    }
    // Check every 500ms if triggerInstall becomes available
    const interval = setInterval(() => {
      if (triggerInstall) setCanInstall(true)
      else setCanInstall(false)
    }, 500)
    // iOS always shows
    if (/iphone|ipad|ipod/i.test(navigator.userAgent)) setCanInstall(true)
    return () => clearInterval(interval)
  }, [])

  if (installed || !canInstall) return null

  return (
    <button
      onClick={() => triggerInstall?.()}
      className="flex items-center gap-1.5 bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
      title="Installa app"
    >
      <Download size={13} />
      <span className="hidden sm:inline">Installa app</span>
    </button>
  )
}
