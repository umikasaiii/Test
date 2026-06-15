import { useApp } from '../context/AppContext'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, CartesianGrid
} from 'recharts'

const COLORS = ['#f97316', '#3b82f6', '#22c55e', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f59e0b']

export default function Report() {
  const { state } = useApp()
  const fmt = (n: number) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })

  // Financial overview
  const totalInvoiced = state.invoices.filter(i => i.status === 'pagata').reduce((s, i) => s + i.total, 0)
  const totalExpenses = state.expenses.filter(e => e.approved).reduce((s, e) => s + e.amount, 0)
  const margin = totalInvoiced - totalExpenses
  const marginPct = totalInvoiced > 0 ? (margin / totalInvoiced) * 100 : 0

  // Monthly revenue vs expenses
  const monthlyData = (() => {
    const months: Record<string, { ricavi: number; spese: number; margine: number }> = {}
    state.invoices.filter(i => i.status === 'pagata').forEach(inv => {
      const m = inv.issueDate.slice(0, 7)
      if (!months[m]) months[m] = { ricavi: 0, spese: 0, margine: 0 }
      months[m].ricavi += inv.total
    })
    state.expenses.filter(e => e.approved).forEach(exp => {
      const m = exp.date.slice(0, 7)
      if (!months[m]) months[m] = { ricavi: 0, spese: 0, margine: 0 }
      months[m].spese += exp.amount
    })
    return Object.entries(months).sort(([a], [b]) => a.localeCompare(b)).map(([month, d]) => ({
      month: new Date(month + '-01').toLocaleDateString('it-IT', { month: 'short', year: '2-digit' }),
      ricavi: d.ricavi, spese: d.spese, margine: d.ricavi - d.spese
    }))
  })()

  // Expenses by category
  const expenseByCategory = (() => {
    const cats: Record<string, number> = {}
    state.expenses.filter(e => e.approved).forEach(e => {
      cats[e.category] = (cats[e.category] || 0) + e.amount
    })
    return Object.entries(cats).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
  })()

  // Revenue by project
  const revenueByProject = state.projects.map(p => {
    const invoiced = state.invoices.filter(i => i.projectId === p.id && i.status === 'pagata').reduce((s, i) => s + i.total, 0)
    const expenses = state.expenses.filter(e => e.projectId === p.id && e.approved).reduce((s, e) => s + e.amount, 0)
    return { name: p.name.length > 20 ? p.name.slice(0, 20) + '…' : p.name, ricavi: invoiced, spese: expenses, margine: invoiced - expenses }
  }).filter(p => p.ricavi > 0 || p.spese > 0)

  // Workers productivity
  const workerStats = state.workers.filter(w => w.active).map(w => {
    const attendances = state.attendances.filter(a => a.workerId === w.id)
    const totalHours = attendances.reduce((s, a) => s + a.hoursWorked + a.overtime, 0)
    const presentDays = attendances.filter(a => a.status === 'presente').length
    return {
      name: `${w.firstName[0]}. ${w.lastName}`,
      ore: totalHours,
      giorni: presentDays,
      costo: presentDays * w.dailyRate
    }
  }).filter(w => w.ore > 0).sort((a, b) => b.ore - a.ore)

  // Client revenue
  const clientRevenue = state.clients.map(c => ({
    name: c.name.length > 18 ? c.name.slice(0, 18) + '…' : c.name,
    value: state.invoices.filter(i => i.clientId === c.id && i.status === 'pagata').reduce((s, i) => s + i.total, 0)
  })).filter(c => c.value > 0).sort((a, b) => b.value - a.value).slice(0, 6)

  // Project status breakdown
  const projectStatus = ['in_corso', 'pianificato', 'completato', 'sospeso', 'annullato'].map(s => ({
    name: { in_corso: 'In Corso', pianificato: 'Pianificato', completato: 'Completato', sospeso: 'Sospeso', annullato: 'Annullato' }[s] || s,
    value: state.projects.filter(p => p.status === s).length
  })).filter(d => d.value > 0)

  return (
    <div className="space-y-6">
      {/* KPI Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Fatturato Incassato', value: fmt(totalInvoiced), color: 'bg-green-500' },
          { label: 'Spese Approvate', value: fmt(totalExpenses), color: 'bg-red-500' },
          { label: 'Margine Netto', value: fmt(margin), color: margin >= 0 ? 'bg-blue-500' : 'bg-red-600' },
          { label: 'Margine %', value: `${marginPct.toFixed(1)}%`, color: marginPct >= 20 ? 'bg-green-500' : marginPct >= 0 ? 'bg-yellow-500' : 'bg-red-500' },
        ].map(kpi => (
          <div key={kpi.label} className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <div className={`w-2 h-8 ${kpi.color} rounded-full mb-3`} />
            <p className="text-2xl font-bold text-gray-800">{kpi.value}</p>
            <p className="text-xs text-gray-500 mt-1">{kpi.label}</p>
          </div>
        ))}
      </div>

      {/* Monthly chart */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
        <h3 className="font-semibold text-gray-700 mb-4">Andamento Economico Mensile</h3>
        {monthlyData.length > 0 ? (
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={monthlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k€`} />
              <Tooltip formatter={(v) => fmt(Number(v))} />
              <Legend />
              <Line type="monotone" dataKey="ricavi" name="Ricavi" stroke="#22c55e" strokeWidth={2} dot={{ fill: '#22c55e' }} />
              <Line type="monotone" dataKey="spese" name="Spese" stroke="#ef4444" strokeWidth={2} dot={{ fill: '#ef4444' }} />
              <Line type="monotone" dataKey="margine" name="Margine" stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 5" dot={{ fill: '#3b82f6' }} />
            </LineChart>
          </ResponsiveContainer>
        ) : <p className="text-center text-gray-400 py-10">Dati insufficienti</p>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Expenses by category */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h3 className="font-semibold text-gray-700 mb-4">Spese per Categoria</h3>
          {expenseByCategory.length > 0 ? (
            <div className="flex gap-4 items-center">
              <div className="flex-1">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={expenseByCategory} cx="50%" cy="50%" outerRadius={80} dataKey="value">
                      {expenseByCategory.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v) => fmt(Number(v))} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-1.5 text-xs min-w-0">
                {expenseByCategory.map((cat, i) => (
                  <div key={cat.name} className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                    <span className="text-gray-600 truncate">{cat.name}</span>
                    <span className="font-medium text-gray-800 ml-auto">{fmt(cat.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : <p className="text-center text-gray-400 py-10">Nessun dato</p>}
        </div>

        {/* Revenue by client */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h3 className="font-semibold text-gray-700 mb-4">Ricavi per Cliente</h3>
          {clientRevenue.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={clientRevenue} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => fmt(Number(v))} />
                <Bar dataKey="value" name="Ricavi" fill="#f97316" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <p className="text-center text-gray-400 py-10">Nessun dato</p>}
        </div>

        {/* Project financial performance */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h3 className="font-semibold text-gray-700 mb-4">Performance Economica Progetti</h3>
          {revenueByProject.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={revenueByProject}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v) => fmt(Number(v))} />
                <Legend />
                <Bar dataKey="ricavi" name="Ricavi" fill="#22c55e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="spese" name="Spese" fill="#f87171" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <p className="text-center text-gray-400 py-10">Nessun dato</p>}
        </div>

        {/* Worker hours */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h3 className="font-semibold text-gray-700 mb-4">Ore Lavorate per Operaio</h3>
          {workerStats.length > 0 ? (
            <div className="space-y-3">
              {workerStats.slice(0, 6).map((w, i) => (
                <div key={w.name}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-700 font-medium">{w.name}</span>
                    <span className="text-gray-500">{w.ore}h • {fmt(w.costo)}</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full">
                    <div className="h-full rounded-full" style={{ background: COLORS[i % COLORS.length], width: `${(w.ore / (workerStats[0]?.ore || 1)) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-center text-gray-400 py-10">Nessun dato presenze</p>}
        </div>
      </div>

      {/* Summary tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Project status */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h3 className="font-semibold text-gray-700 mb-4">Stato Progetti</h3>
          <div className="space-y-2">
            {projectStatus.map((s, i) => (
              <div key={s.name} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ background: COLORS[i] }} />
                  <span className="text-sm text-gray-700">{s.name}</span>
                </div>
                <span className="font-bold text-gray-800">{s.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Invoice stats */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h3 className="font-semibold text-gray-700 mb-4">Riepilogo Fatture</h3>
          <div className="space-y-2">
            {[
              { label: 'Pagate', filter: (i: any) => i.status === 'pagata', color: 'text-green-600' },
              { label: 'Inviate', filter: (i: any) => i.status === 'inviata', color: 'text-blue-600' },
              { label: 'Scadute', filter: (i: any) => i.status === 'scaduta', color: 'text-red-600' },
              { label: 'Bozze', filter: (i: any) => i.status === 'bozza', color: 'text-gray-500' },
            ].map(row => {
              const invs = state.invoices.filter(row.filter)
              const tot = invs.reduce((s: number, i: any) => s + i.total, 0)
              return (
                <div key={row.label} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-700">{row.label}</span>
                    <span className="text-xs text-gray-400">{invs.length} ft.</span>
                  </div>
                  <span className={`font-bold ${row.color}`}>{fmt(tot)}</span>
                </div>
              )
            })}
            <div className="flex items-center justify-between p-3 bg-gray-800 rounded-lg">
              <span className="text-sm text-white font-semibold">Totale Emesso</span>
              <span className="font-bold text-white">{fmt(state.invoices.reduce((s, i) => s + i.total, 0))}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
