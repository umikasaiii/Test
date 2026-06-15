import { useState } from 'react'
import { useApp } from '../context/AppContext'
import type { Task } from '../types'
import { generateId } from '../utils/storage'
import Modal from '../components/ui/Modal'
import Badge from '../components/ui/Badge'
import { Input, Select, Textarea } from '../components/ui/FormField'
import { Plus, Search, Edit2, Trash2, CheckCircle, Clock, Circle } from 'lucide-react'

const PRIORITY_COLOR: Record<string, 'green' | 'yellow' | 'orange' | 'red'> = {
  bassa: 'green', media: 'yellow', alta: 'orange', urgente: 'red'
}

type TaskStatus = 'da_fare' | 'in_corso' | 'completata'
type TaskPriority = 'bassa' | 'media' | 'alta' | 'urgente'

const empty: { projectId: string; title: string; description: string; assignedTo: string[]; status: TaskStatus; priority: TaskPriority; startDate: string; dueDate: string } = {
  projectId: '', title: '', description: '', assignedTo: [],
  status: 'da_fare', priority: 'media', startDate: '', dueDate: ''
}

export default function Attivita() {
  const { state, dispatch } = useApp()
  const [search, setSearch] = useState('')
  const [filterProject, setFilterProject] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState<Task | null>(null)
  const [form, setForm] = useState(empty)

  const filtered = state.tasks.filter(t => {
    const matchSearch = !search || t.title.toLowerCase().includes(search.toLowerCase())
    const matchProject = !filterProject || t.projectId === filterProject
    const matchStatus = !filterStatus || t.status === filterStatus
    return matchSearch && matchProject && matchStatus
  })

  const grouped = {
    da_fare: filtered.filter(t => t.status === 'da_fare'),
    in_corso: filtered.filter(t => t.status === 'in_corso'),
    completata: filtered.filter(t => t.status === 'completata'),
  }

  function openNew() {
    setEditing(null)
    setForm(empty)
    setModal(true)
  }
  function openEdit(t: Task) {
    setEditing(t)
    setForm({ projectId: t.projectId, title: t.title, description: t.description, assignedTo: t.assignedTo, status: t.status, priority: t.priority, startDate: t.startDate, dueDate: t.dueDate })
    setModal(true)
  }

  function save() {
    const now = new Date().toISOString()
    if (editing) {
      dispatch({ type: 'UPDATE_TASK', payload: { ...editing, ...form, updatedAt: now } as Task })
    } else {
      dispatch({ type: 'ADD_TASK', payload: { id: generateId(), ...form, createdAt: now } as Task })
    }
    setModal(false)
  }

  function cycleStatus(t: Task) {
    const next: Record<string, Task['status']> = { da_fare: 'in_corso', in_corso: 'completata', completata: 'da_fare' }
    dispatch({ type: 'UPDATE_TASK', payload: { ...t, status: next[t.status], completedAt: next[t.status] === 'completata' ? new Date().toISOString() : undefined } })
  }

  function del(id: string) {
    if (confirm('Eliminare questo task?')) dispatch({ type: 'DELETE_TASK', payload: id })
  }

  const StatusIcon = ({ status }: { status: Task['status'] }) => {
    if (status === 'completata') return <CheckCircle size={16} className="text-green-500" />
    if (status === 'in_corso') return <Clock size={16} className="text-blue-500" />
    return <Circle size={16} className="text-gray-400" />
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca task..." className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" />
        </div>
        <select value={filterProject} onChange={e => setFilterProject(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400">
          <option value="">Tutti i progetti</option>
          {state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400">
          <option value="">Tutti gli stati</option>
          <option value="da_fare">Da Fare</option>
          <option value="in_corso">In Corso</option>
          <option value="completata">Completata</option>
        </select>
        <button onClick={openNew} className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
          <Plus size={16} /> Nuovo Task
        </button>
      </div>

      {/* Kanban columns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {(['da_fare', 'in_corso', 'completata'] as const).map(col => (
          <div key={col} className="bg-gray-100 rounded-xl p-4 min-h-64">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-sm text-gray-700">
                {col === 'da_fare' ? 'Da Fare' : col === 'in_corso' ? 'In Corso' : 'Completate'}
              </h3>
              <span className="bg-white text-gray-600 text-xs font-medium px-2 py-0.5 rounded-full">{grouped[col].length}</span>
            </div>
            <div className="space-y-3">
              {grouped[col].map(t => {
                const project = state.projects.find(p => p.id === t.projectId)
                const assignees = state.workers.filter(w => t.assignedTo.includes(w.id))
                return (
                  <div key={t.id} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
                    <div className="flex items-start gap-2">
                      <button onClick={() => cycleStatus(t)} className="mt-0.5 flex-shrink-0 hover:scale-110 transition-transform">
                        <StatusIcon status={t.status} />
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className={`font-medium text-sm ${t.status === 'completata' ? 'line-through text-gray-400' : 'text-gray-800'}`}>{t.title}</p>
                        {project && <p className="text-xs text-gray-400 mt-0.5 truncate">{project.name}</p>}
                        {t.description && <p className="text-xs text-gray-500 mt-1 line-clamp-2">{t.description}</p>}
                      </div>
                    </div>
                    <div className="flex items-center justify-between mt-3 pt-2 border-t border-gray-50">
                      <div className="flex items-center gap-1.5">
                        <Badge label={t.priority.charAt(0).toUpperCase() + t.priority.slice(1)} color={PRIORITY_COLOR[t.priority]} />
                        {t.dueDate && <span className="text-xs text-gray-400">{t.dueDate}</span>}
                      </div>
                      <div className="flex gap-1">
                        <button onClick={() => openEdit(t)} className="p-1 text-gray-400 hover:text-orange-500 rounded"><Edit2 size={13} /></button>
                        <button onClick={() => del(t.id)} className="p-1 text-gray-400 hover:text-red-500 rounded"><Trash2 size={13} /></button>
                      </div>
                    </div>
                    {assignees.length > 0 && (
                      <div className="mt-2 flex gap-1 flex-wrap">
                        {assignees.map(w => (
                          <span key={w.id} className="bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded">{w.firstName[0]}.{w.lastName}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {modal && (
        <Modal title={editing ? 'Modifica Task' : 'Nuovo Task'} onClose={() => setModal(false)} size="lg">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Input label="Titolo Task" required value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
            </div>
            <Select label="Progetto" value={form.projectId} onChange={e => setForm(f => ({ ...f, projectId: e.target.value }))}
              options={[{ value: '', label: '-- Seleziona progetto --' }, ...state.projects.map(p => ({ value: p.id, label: p.name }))]} />
            <Select label="Priorità" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value as any }))}
              options={[{ value: 'bassa', label: 'Bassa' }, { value: 'media', label: 'Media' }, { value: 'alta', label: 'Alta' }, { value: 'urgente', label: 'Urgente' }]} />
            <Select label="Stato" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as any }))}
              options={[{ value: 'da_fare', label: 'Da Fare' }, { value: 'in_corso', label: 'In Corso' }, { value: 'completata', label: 'Completata' }]} />
            <div />
            <Input label="Data Inizio" type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} />
            <Input label="Scadenza" type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
            <div className="sm:col-span-2">
              <Textarea label="Descrizione" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Assegna a</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 border border-gray-200 rounded-lg p-3">
                {state.workers.filter(w => w.active).map(w => (
                  <label key={w.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={form.assignedTo.includes(w.id)}
                      onChange={e => setForm(f => ({ ...f, assignedTo: e.target.checked ? [...f.assignedTo, w.id] : f.assignedTo.filter(id => id !== w.id) }))} />
                    {w.firstName} {w.lastName}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-5 pt-4 border-t border-gray-100">
            <button onClick={() => setModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Annulla</button>
            <button onClick={save} className="px-5 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600">Salva</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
