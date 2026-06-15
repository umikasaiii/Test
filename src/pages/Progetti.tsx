import { useState } from 'react'
import { useApp } from '../context/AppContext'
import type { Project, ProjectStatus, ProjectPhase } from '../types'
import { generateId } from '../utils/storage'
import Modal from '../components/ui/Modal'
import Badge from '../components/ui/Badge'
import { Input, Select, Textarea } from '../components/ui/FormField'
import { Plus, Search, Edit2, Trash2, Eye, Users, Euro, Calendar } from 'lucide-react'

const STATUS_OPTIONS = [
  { value: 'pianificato', label: 'Pianificato' },
  { value: 'in_corso', label: 'In Corso' },
  { value: 'sospeso', label: 'Sospeso' },
  { value: 'completato', label: 'Completato' },
  { value: 'annullato', label: 'Annullato' },
]
const PHASE_OPTIONS = [
  { value: 'progettazione', label: 'Progettazione' },
  { value: 'permessi', label: 'Permessi' },
  { value: 'demolizioni', label: 'Demolizioni' },
  { value: 'fondazioni', label: 'Fondazioni' },
  { value: 'struttura', label: 'Struttura' },
  { value: 'impiantistica', label: 'Impiantistica' },
  { value: 'finiture', label: 'Finiture' },
  { value: 'collaudo', label: 'Collaudo' },
]
const STATUS_COLOR: Record<string, 'blue' | 'gray' | 'green' | 'yellow' | 'red'> = {
  in_corso: 'blue', pianificato: 'gray', completato: 'green', sospeso: 'yellow', annullato: 'red'
}

const empty: Omit<Project, 'id' | 'createdAt' | 'updatedAt'> = {
  name: '', code: '', clientId: '', address: '', city: '', description: '',
  status: 'pianificato', phase: 'progettazione', startDate: '', endDate: '',
  budget: 0, progress: 0, managerId: '', workers: [], notes: ''
}

export default function Progetti() {
  const { state, dispatch } = useApp()
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [modal, setModal] = useState<'form' | 'detail' | null>(null)
  const [editing, setEditing] = useState<Project | null>(null)
  const [form, setForm] = useState(empty)
  const [detail, setDetail] = useState<Project | null>(null)

  const filtered = state.projects.filter(p => {
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.code.toLowerCase().includes(search.toLowerCase()) || p.city.toLowerCase().includes(search.toLowerCase())
    const matchStatus = !filterStatus || p.status === filterStatus
    return matchSearch && matchStatus
  })

  function openNew() {
    setEditing(null)
    setForm(empty)
    setModal('form')
  }
  function openEdit(p: Project) {
    setEditing(p)
    setForm({ name: p.name, code: p.code, clientId: p.clientId, address: p.address, city: p.city, description: p.description, status: p.status, phase: p.phase, startDate: p.startDate, endDate: p.endDate, budget: p.budget, progress: p.progress, managerId: p.managerId, workers: p.workers, notes: p.notes })
    setModal('form')
  }
  function openDetail(p: Project) {
    setDetail(p)
    setModal('detail')
  }

  function save() {
    const now = new Date().toISOString()
    if (editing) {
      dispatch({ type: 'UPDATE_PROJECT', payload: { ...editing, ...form, updatedAt: now } })
    } else {
      dispatch({ type: 'ADD_PROJECT', payload: { id: generateId(), ...form, createdAt: now, updatedAt: now } })
    }
    setModal(null)
  }

  function del(id: string) {
    if (confirm('Eliminare questo progetto?')) dispatch({ type: 'DELETE_PROJECT', payload: id })
  }

  const fmt = (n: number) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca progetto..." className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400">
          <option value="">Tutti gli stati</option>
          {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button onClick={openNew} className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors">
          <Plus size={16} /> Nuovo Progetto
        </button>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map(p => {
          const client = state.clients.find(c => c.id === p.clientId)
          const expenses = state.expenses.filter(e => e.projectId === p.id).reduce((s, e) => s + e.amount, 0)
          const workers = state.workers.filter(w => p.workers.includes(w.id))
          return (
            <div key={p.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="min-w-0">
                  <p className="text-xs text-gray-400 font-mono">{p.code}</p>
                  <h3 className="font-semibold text-gray-800 text-sm leading-tight mt-0.5">{p.name}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{client?.name || '—'}</p>
                </div>
                <Badge label={STATUS_OPTIONS.find(s => s.value === p.status)?.label || p.status} color={STATUS_COLOR[p.status]} />
              </div>

              <div className="space-y-1 text-xs text-gray-500 mb-3">
                <div className="flex items-center gap-1.5"><Calendar size={12} /> {p.startDate} → {p.endDate || '—'}</div>
                <div className="flex items-center gap-1.5"><Euro size={12} /> Budget: <span className="font-medium text-gray-700">{fmt(p.budget)}</span> | Spese: <span className="font-medium text-red-600">{fmt(expenses)}</span></div>
                <div className="flex items-center gap-1.5"><Users size={12} /> {workers.length} operai assegnati</div>
              </div>

              <div className="mb-3">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>Avanzamento</span>
                  <span className="font-medium">{p.progress}%</span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full">
                  <div className="h-full rounded-full bg-blue-500" style={{ width: `${p.progress}%` }} />
                </div>
              </div>

              <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100">
                <button onClick={() => openDetail(p)} className="flex-1 flex items-center justify-center gap-1 text-xs text-gray-600 hover:text-blue-600 py-1.5 hover:bg-blue-50 rounded-lg transition-colors">
                  <Eye size={13} /> Dettaglio
                </button>
                <button onClick={() => openEdit(p)} className="flex-1 flex items-center justify-center gap-1 text-xs text-gray-600 hover:text-orange-600 py-1.5 hover:bg-orange-50 rounded-lg transition-colors">
                  <Edit2 size={13} /> Modifica
                </button>
                <button onClick={() => del(p.id)} className="flex items-center justify-center gap-1 text-xs text-gray-400 hover:text-red-600 px-3 py-1.5 hover:bg-red-50 rounded-lg transition-colors">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          )
        })}
        {filtered.length === 0 && (
          <div className="col-span-3 text-center py-16 text-gray-400">
            <FolderKanbanIcon />
            <p className="mt-2">Nessun progetto trovato</p>
          </div>
        )}
      </div>

      {/* Form Modal */}
      {modal === 'form' && (
        <Modal title={editing ? 'Modifica Progetto' : 'Nuovo Progetto'} onClose={() => setModal(null)} size="xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Nome Progetto" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Es. Ristrutturazione Villa Rossi" />
            <Input label="Codice Progetto" required value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} placeholder="Es. PRJ-2024-001" />
            <Select label="Cliente" required value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}
              options={[{ value: '', label: '-- Seleziona cliente --' }, ...state.clients.map(c => ({ value: c.id, label: c.name }))]} />
            <Select label="Responsabile" value={form.managerId} onChange={e => setForm(f => ({ ...f, managerId: e.target.value }))}
              options={[{ value: '', label: '-- Seleziona --' }, ...state.workers.map(w => ({ value: w.id, label: `${w.firstName} ${w.lastName}` }))]} />
            <Input label="Indirizzo" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
            <Input label="Città" value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} />
            <Select label="Stato" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as ProjectStatus }))} options={STATUS_OPTIONS} />
            <Select label="Fase Corrente" value={form.phase} onChange={e => setForm(f => ({ ...f, phase: e.target.value as ProjectPhase }))} options={PHASE_OPTIONS} />
            <Input label="Data Inizio" type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} />
            <Input label="Data Fine Prevista" type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} />
            <Input label="Budget (€)" type="number" value={form.budget} onChange={e => setForm(f => ({ ...f, budget: +e.target.value }))} />
            <Input label="Avanzamento (%)" type="number" min="0" max="100" value={form.progress} onChange={e => setForm(f => ({ ...f, progress: +e.target.value }))} />
            <div className="sm:col-span-2">
              <Textarea label="Descrizione" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Operai Assegnati</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-3">
                {state.workers.filter(w => w.active).map(w => (
                  <label key={w.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={form.workers.includes(w.id)}
                      onChange={e => setForm(f => ({ ...f, workers: e.target.checked ? [...f.workers, w.id] : f.workers.filter(id => id !== w.id) }))} />
                    {w.firstName} {w.lastName}
                  </label>
                ))}
              </div>
            </div>
            <div className="sm:col-span-2">
              <Textarea label="Note" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} />
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-5 pt-4 border-t border-gray-100">
            <button onClick={() => setModal(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Annulla</button>
            <button onClick={save} className="px-5 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600">Salva</button>
          </div>
        </Modal>
      )}

      {/* Detail Modal */}
      {modal === 'detail' && detail && (
        <Modal title={detail.name} onClose={() => setModal(null)} size="xl">
          <ProjectDetail project={detail} state={state} fmt={fmt} />
        </Modal>
      )}
    </div>
  )
}

function FolderKanbanIcon() {
  return (
    <svg width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" className="mx-auto opacity-40">
      <path d="M2 6a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  )
}

function ProjectDetail({ project: p, state, fmt }: { project: Project; state: any; fmt: (n: number) => string }) {
  const client = state.clients.find((c: any) => c.id === p.clientId)
  const manager = state.workers.find((w: any) => w.id === p.managerId)
  const assignedWorkers = state.workers.filter((w: any) => p.workers.includes(w.id))
  const tasks = state.tasks.filter((t: any) => t.projectId === p.id)
  const expenses = state.expenses.filter((e: any) => e.projectId === p.id)
  const totalExpenses = expenses.reduce((s: number, e: any) => s + e.amount, 0)
  const invoices = state.invoices.filter((i: any) => i.projectId === p.id)
  const totalInvoiced = invoices.reduce((s: number, i: any) => s + i.total, 0)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div><p className="text-gray-400">Codice</p><p className="font-medium">{p.code}</p></div>
        <div><p className="text-gray-400">Cliente</p><p className="font-medium">{client?.name || '—'}</p></div>
        <div><p className="text-gray-400">Indirizzo</p><p className="font-medium">{p.address}, {p.city}</p></div>
        <div><p className="text-gray-400">Responsabile</p><p className="font-medium">{manager ? `${manager.firstName} ${manager.lastName}` : '—'}</p></div>
        <div><p className="text-gray-400">Data Inizio</p><p className="font-medium">{p.startDate}</p></div>
        <div><p className="text-gray-400">Data Fine</p><p className="font-medium">{p.endDate || '—'}</p></div>
        <div><p className="text-gray-400">Budget</p><p className="font-semibold text-gray-800">{fmt(p.budget)}</p></div>
        <div><p className="text-gray-400">Avanzamento</p><p className="font-semibold text-blue-600">{p.progress}%</p></div>
      </div>

      <div className="h-2 bg-gray-100 rounded-full">
        <div className="h-full rounded-full bg-blue-500" style={{ width: `${p.progress}%` }} />
      </div>

      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="bg-blue-50 rounded-lg p-3">
          <p className="text-lg font-bold text-blue-700">{fmt(totalInvoiced)}</p>
          <p className="text-xs text-blue-500">Fatturato</p>
        </div>
        <div className="bg-red-50 rounded-lg p-3">
          <p className="text-lg font-bold text-red-700">{fmt(totalExpenses)}</p>
          <p className="text-xs text-red-500">Spese</p>
        </div>
        <div className="bg-green-50 rounded-lg p-3">
          <p className="text-lg font-bold text-green-700">{fmt(totalInvoiced - totalExpenses)}</p>
          <p className="text-xs text-green-500">Margine</p>
        </div>
      </div>

      {p.description && <div><p className="text-sm text-gray-500 font-medium mb-1">Descrizione</p><p className="text-sm text-gray-700">{p.description}</p></div>}

      <div>
        <p className="text-sm font-medium text-gray-700 mb-2">Operai Assegnati ({assignedWorkers.length})</p>
        <div className="flex flex-wrap gap-2">
          {assignedWorkers.map((w: any) => (
            <span key={w.id} className="bg-gray-100 text-gray-700 px-2.5 py-1 rounded-full text-xs">{w.firstName} {w.lastName} — {w.role}</span>
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-medium text-gray-700 mb-2">Task ({tasks.length})</p>
        <div className="space-y-1">
          {tasks.map((t: any) => (
            <div key={t.id} className="flex items-center justify-between text-sm bg-gray-50 px-3 py-2 rounded-lg">
              <span className="text-gray-700">{t.title}</span>
              <Badge label={t.status === 'completata' ? 'Completata' : t.status === 'in_corso' ? 'In Corso' : 'Da Fare'}
                color={t.status === 'completata' ? 'green' : t.status === 'in_corso' ? 'blue' : 'gray'} />
            </div>
          ))}
          {tasks.length === 0 && <p className="text-sm text-gray-400">Nessun task</p>}
        </div>
      </div>

      {p.notes && <div><p className="text-sm text-gray-500 font-medium mb-1">Note</p><p className="text-sm text-gray-700">{p.notes}</p></div>}
    </div>
  )
}
