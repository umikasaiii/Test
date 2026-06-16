import HeroSection from './HeroSection'
import TopNav from './TopNav'
import BottomNav from './BottomNav'
import InstallPrompt from '../ui/InstallPrompt'

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: 'linear-gradient(180deg,#FFF3E2,#FFE2B8)' }}>
      <HeroSection />
      <TopNav />

      <main className="max-w-7xl mx-auto px-3 lg:px-6 pt-4 pb-24 lg:pb-8">
        {children}
      </main>

      <BottomNav />
      <InstallPrompt />
    </div>
  )
}
