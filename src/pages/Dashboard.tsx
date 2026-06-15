import { useApp } from '../context/AppContext'
import StatCard from '../components/ui/StatCard'
import Badge from '../components/ui/Badge'
import {
  FolderKanban, Users, Receipt, TrendingUp, AlertTriangle,
  CheckCircle, Clock, Package, Euro
} from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts'
import { useNavigate } from 'react-router-dom'

const STATUS_COLORS: Record<string, string> = {
  in_corso: 'blue', pianificato: 'gray', completato: 'green', sospeso: 'yellow', annullato: 'red'
}
const STATUS_LABEL: Record<string, string> = {
  in_corso: 'In Corso', pianificato: 'Pianificato', completato: 'Completato', sospeso: 'Sospeso', annullato: 'Annullato'
}
const INV_COLORS: Record<string, string> = {
  pagata: 'green', inviata: 'blue', scaduta: 'red', bozza: 'gray', annullata: 'gray'
}
const INV_LABEL: Record<string, string> = {
  pagata: 'Pagata', inviata: 'Inviata', scaduta: 'Scaduta', bozza: 'Bozza', annullata: 'Annullata'
}

const PIE_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6']

export default function Dashboard() {
  const { state } = useApp()
  const navigate = useNavigate()

  const activeProjects = state.projects.filter(p => p.status === 'in_corso')
  const totalRevenue = state.invoices.filter(i => i.status === 'pagata').reduce((s, i) => s + i.total, 0)
  const pendingRevenue = state.invoices.filter(i => i.status === 'inviata' || i.status === 'scaduta').reduce((s, i) => s + i.total, 0)
  const totalExpenses = state.expenses.reduce((s, e) => s + e.amount, 0)
  const activeWorkers = state.workers.filter(w => w.active).length
  const lowStockItems = state.materials.filter(m => m.stock <= m.minStock)
  const overdueInvoices = state.invoices.filter(i => i.status === 'scaduta')
  const openTasks = state.tasks.filter(t => t.status !== 'completata')

  const projectStatusData = ['in_corso', 'pianificato', 'completato', 'sospeso'].map(s => ({
    name: STATUS_LABEL[s],
    value: state.projects.filter(p => p.status === s).length,
  })).filter(d => d.value > 0)

  const monthlyData = (() => {
    const months: Record<string, { fatturato: number; spese: number }> = {}
    state.invoices.filter(i => i.status === 'pagata').forEach(inv => {
      const m = inv.issueDate.slice(0, 7)
      if (!months[m]) months[m] = { fatturato: 0, spese: 0 }
      months[m].fatturato += inv.total
    })
    state.expenses.forEach(exp => {
      const m = exp.date.slice(0, 7)
      if (!months[m]) months[m] = { fatturato: 0, spese: 0 }
      months[m].spese += exp.amount
    })
    return Object.entries(months).sort(([a], [b]) => a.localeCompare(b)).slice(-6).map(([month, data]) => ({
      month: new Date(month + '-01').toLocaleDateString('it-IT', { month: 'short', year: '2-digit' }),
      ...data,
    }))
  })()

  const fmt = (n: number) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })

  return (
    <div className="space-y-6">
      {/* Alert banner */}
      {(overdueInvoices.length > 0 || lowStockItems.length > 0) && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="text-red-500 flex-shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-red-700">
            {overdueInvoices.length > 0 && <p><strong>{overdueInvoices.length} fattura/e scaduta/e</strong> in attesa di pagamento</p>}
            {lowStockItems.length > 0 && <p><strong>{lowStockItems.length} materiale/i</strong> sotto la scorta minima in magazzino</p>}
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Progetti Attivi"
          value={activeProjects.length}
          subtitle={`su ${state.projects.length} totali`}
          icon={<FolderKanban size={22} />}
          color="bg-blue-500"
        />
        <StatCard
          title="Fatturato Incassato"
          value={fmt(totalRevenue)}
          subtitle={`${fmt(pendingRevenue)} da incassare`}
          icon={<Euro size={22} />}
          color="bg-green-500"
        />
        <StatCard
          title="Operai Attivi"
          value={activeWorkers}
          subtitle={`${state.workers.length} in totale`}
          icon={<Users size={22} />}
          color="bg-orange-500"
        />
        <StatCard
          title="Spese Totali"
          value={fmt(totalExpenses)}
          subtitle={`Margine: ${fmt(totalRevenue - totalExpenses)}`}
          icon={<TrendingUp size={22} />}
          color="bg-purple-500"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Charts */}
        <div className="lg:col-span-2 bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h3 className="font-semibold text-gray-700 mb-4">Andamento Economico (ultimi 6 mesi)</h3>
          {monthlyData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={monthlyData} barGap={4}>
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v) => fmt(Number(v))} />
                <Legend />
                <Bar dataKey="fatturato" name="Fatturato" fill="#22c55e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="spese" name="Spese" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-52 flex items-center justify-center text-gray-400 text-sm">Nessun dato disponibile</div>
          )}
        </div>

        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h3 className="font-semibold text-gray-700 mb-4">Stato Progetti</h3>
          {projectStatusData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={projectStatusData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value" label={({ name, value }) => `${name}: ${value}`} labelLine={false}>
                  {projectStatusData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-52 flex items-center justify-center text-gray-400 text-sm">Nessun progetto</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Progetti in corso */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-700">Progetti in Corso</h3>
            <button onClick={() => navigate('/progetti')} className="text-sm text-orange-500 hover:text-orange-600">Vedi tutti</button>
          </div>
          <div className="space-y-3">
            {activeProjects.slice(0, 4).map(p => {
              const client = state.clients.find(c => c.id === p.clientId)
              return (
                <div key={p.id} className="p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-sm text-gray-800 truncate">{p.name}</p>
                      <p className="text-xs text-gray-500">{client?.name} — {p.city}</p>
                    </div>
                    <Badge label={STATUS_LABEL[p.status]} color={STATUS_COLORS[p.status] as any} />
                  </div>
                  <div className="mt-2">
                    <div className="flex justify-between text-xs text-gray-500 mb-1">
                      <span>Avanzamento</span>
                      <span>{p.progress}%</span>
                    </div>
                    <div className="h-1.5 bg-gray-200 rounded-full">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-all"
                        style={{ width: `${p.progress}%` }}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
            {activeProjects.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-4">Nessun progetto attivo</p>
            )}
          </div>
        </div>

        {/* Riepilogo rapido */}
        <div className="space-y-4">
          {/* Fatture */}
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-700">Fatture Recenti</h3>
              <button onClick={() => navigate('/fatture')} className="text-sm text-orange-500 hover:text-orange-600">Vedi tutte</button>
            </div>
            <div className="space-y-2">
              {state.invoices.slice(0, 3).map(inv => {
                const client = state.clients.find(c => c.id === inv.clientId)
                return (
                  <div key={inv.id} className="flex items-center justify-between text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-gray-700 truncate">{inv.number}</p>
                      <p className="text-xs text-gray-400 truncate">{client?.name}</p>
                    </div>
                    <div className="text-right flex-shrink-0 ml-2">
                      <p className="font-semibold text-gray-700">{fmt(inv.total)}</p>
                      <Badge label={INV_LABEL[inv.status]} color={INV_COLORS[inv.status] as any} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Quick stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center">
              <CheckCircle className="text-green-500 mx-auto mb-1" size={22} />
              <p className="text-xl font-bold text-gray-800">{state.tasks.filter(t => t.status === 'completata').length}</p>
              <p className="text-xs text-gray-500">Task completati</p>
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center">
              <Clock className="text-yellow-500 mx-auto mb-1" size={22} />
              <p className="text-xl font-bold text-gray-800">{openTasks.length}</p>
              <p className="text-xs text-gray-500">Task aperti</p>
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center">
              <Package className="text-red-500 mx-auto mb-1" size={22} />
              <p className="text-xl font-bold text-gray-800">{lowStockItems.length}</p>
              <p className="text-xs text-gray-500">Scorte basse</p>
            </div>
          </div>

          {/* Fatture scadute */}
          {overdueInvoices.length > 0 && (
            <div className="bg-red-50 rounded-xl p-4 border border-red-200">
              <div className="flex items-center gap-2 mb-2">
                <Receipt className="text-red-500" size={16} />
                <p className="font-semibold text-sm text-red-700">Fatture Scadute</p>
              </div>
              {overdueInvoices.map(inv => (
                <div key={inv.id} className="flex justify-between text-sm">
                  <span className="text-red-600">{inv.number}</span>
                  <span className="font-semibold text-red-700">{fmt(inv.total)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
