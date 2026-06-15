import { useState, useEffect } from 'react'
import { Download, X } from 'lucide-react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)
  const [isIOS, setIsIOS] = useState(false)

  useEffect(() => {
    // Detect iOS
    const ios = /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase())
    const standalone = ('standalone' in navigator) && (navigator as any).standalone
    if (ios && !standalone) {
      setIsIOS(true)
      const dismissed = sessionStorage.getItem('pwa-ios-dismissed')
      if (!dismissed) setVisible(true)
      return
    }

    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
      const dismissed = sessionStorage.getItem('pwa-dismissed')
      if (!dismissed) setVisible(true)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  async function install() {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') setVisible(false)
    setDeferredPrompt(null)
  }

  function dismiss() {
    setVisible(false)
    sessionStorage.setItem(isIOS ? 'pwa-ios-dismissed' : 'pwa-dismissed', '1')
  }

  if (!visible) return null

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 max-w-sm mx-auto">
      <div className="bg-gray-900 text-white rounded-2xl shadow-2xl p-4 flex items-start gap-3 border border-gray-700">
        <div className="bg-orange-500 rounded-xl p-2 flex-shrink-0 mt-0.5">
          <Download size={18} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm">Installa EdilGestionale</p>
          {isIOS ? (
            <p className="text-xs text-gray-300 mt-1">
              Tocca <span className="text-orange-400 font-medium">Condividi</span> → <span className="text-orange-400 font-medium">"Aggiungi a schermata Home"</span> per installare l'app.
            </p>
          ) : (
            <p className="text-xs text-gray-300 mt-1">
              Installa l'app sul tuo dispositivo per accedere offline.
            </p>
          )}
          {!isIOS && (
            <button
              onClick={install}
              className="mt-2 bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold px-4 py-1.5 rounded-lg transition-colors"
            >
              Installa ora
            </button>
          )}
        </div>
        <button onClick={dismiss} className="text-gray-400 hover:text-white flex-shrink-0 p-1">
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
