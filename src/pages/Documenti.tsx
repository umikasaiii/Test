import { useState } from 'react'
import { useApp } from '../context/AppContext'
import type { Document } from '../types'
import { generateId } from '../utils/storage'
import Modal from '../components/ui/Modal'
import Badge from '../components/ui/Badge'
import { Input, Select, Textarea } from '../components/ui/FormField'
import { Plus, Search, Edit2, Trash2, FileText, AlertTriangle } from 'lucide-react'

const CATEGORY_OPTIONS = [
  { value: 'contratto', label: 'Contratto', color: 'blue' as const },
  { value: 'permesso', label: 'Permesso', color: 'orange' as const },
  { value: 'progetto', label: 'Progetto', color: 'purple' as const },
  { value: 'collaudo', label: 'Collaudo', color: 'green' as const },
  { value: 'sicurezza', label: 'Sicurezza', color: 'red' as const },
  { value: 'altro', label: 'Altro', color: 'gray' as const },
]

type DocCategory = 'contratto' | 'permesso' | 'progetto' | 'collaudo' | 'sicurezza' | 'altro'
const empty: { projectId: string; name: string; type: string; category: DocCategory; uploadDate: string; expiryDate: string; notes: string } = {
  projectId: '', name: '', type: 'PDF', category: 'contratto',
  uploadDate: new Date().toISOString().slice(0, 10), expiryDate: '', notes: ''
}

export default function Documenti() {
  const { state, dispatch } = useApp()
  const [search, setSearch] = useState('')
  const [filterProject, setFilterProject] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState<Document | null>(null)
  const [form, setForm] = useState(empty)

  const today = new Date().toISOString().slice(0, 10)
  const expiringSoon = state.documents.filter(d => d.expiryDate && d.expiryDate > today && d.expiryDate <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10))
  const expired = state.documents.filter(d => d.expiryDate && d.expiryDate < today)

  const filtered = state.documents.filter(d => {
    const matchSearch = !search || d.name.toLowerCase().includes(search.toLowerCase())
    const matchProject = !filterProject || d.projectId === filterProject
    const matchCategory = !filterCategory || d.category === filterCategory
    return matchSearch && matchProject && matchCategory
  })

  function openNew() { setEditing(null); setForm(empty); setModal(true) }
  function openEdit(d: Document) {
    setEditing(d)
    setForm({ projectId: d.projectId || '', name: d.name, type: d.type, category: d.category, uploadDate: d.uploadDate, expiryDate: d.expiryDate || '', notes: d.notes })
    setModal(true)
  }
  function save() {
    const now = new Date().toISOString()
    const payload = { ...form, expiryDate: form.expiryDate || undefined, projectId: form.projectId || undefined }
    if (editing) dispatch({ type: 'UPDATE_DOCUMENT', payload: { ...editing, ...payload } })
    else dispatch({ type: 'ADD_DOCUMENT', payload: { id: generateId(), ...payload, createdAt: now } as Document })
    setModal(false)
  }
  function del(id: string) { if (confirm('Eliminare questo documento?')) dispatch({ type: 'DELETE_DOCUMENT', payload: id }) }

  return (
    <div className="space-y-5">
      {(expired.length > 0 || expiringSoon.length > 0) && (
        <div className="space-y-2">
          {expired.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
              <AlertTriangle className="text-red-500 flex-shrink-0 mt-0.5" size={18} />
              <div className="text-sm text-red-700">
                <strong>{expired.length} documento/i scaduto/i:</strong> {expired.map(d => d.name).join(', ')}
              </div>
            </div>
          )}
          {expiringSoon.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
              <AlertTriangle className="text-amber-500 flex-shrink-0 mt-0.5" size={18} />
              <div className="text-sm text-amber-700">
                <strong>{expiringSoon.length} documento/i in scadenza (30 gg):</strong> {expiringSoon.map(d => d.name).join(', ')}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca documento..." className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" />
        </div>
        <select value={filterProject} onChange={e => setFilterProject(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <option value="">Tutti i progetti</option>
          <option value="">Aziendali</option>
          {state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <option value="">Tutte le categorie</option>
          {CATEGORY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <button onClick={openNew} className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
          <Plus size={16} /> Nuovo Documento
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map(d => {
          const project = state.projects.find(p => p.id === d.projectId)
          const catInfo = CATEGORY_OPTIONS.find(c => c.value === d.category)
          const isExpired = d.expiryDate && d.expiryDate < today
          const isExpiringSoon = d.expiryDate && d.expiryDate >= today && d.expiryDate <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
          return (
            <div key={d.id} className={`bg-white rounded-xl border shadow-sm p-4 ${isExpired ? 'border-red-200 bg-red-50/30' : isExpiringSoon ? 'border-amber-200 bg-amber-50/30' : 'border-gray-100'}`}>
              <div className="flex items-start gap-3 mb-3">
                <div className={`p-2.5 rounded-lg ${catInfo?.color === 'red' ? 'bg-red-100' : catInfo?.color === 'blue' ? 'bg-blue-100' : catInfo?.color === 'green' ? 'bg-green-100' : 'bg-gray-100'}`}>
                  <FileText size={18} className={`${catInfo?.color === 'red' ? 'text-red-500' : catInfo?.color === 'blue' ? 'text-blue-500' : catInfo?.color === 'green' ? 'text-green-500' : 'text-gray-500'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm text-gray-800 leading-tight truncate">{d.name}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{d.type} • {d.uploadDate}</p>
                </div>
                <Badge label={catInfo?.label || d.category} color={catInfo?.color || 'gray'} />
              </div>
              {project && <p className="text-xs text-gray-500 mb-2">Progetto: {project.name}</p>}
              {d.expiryDate && (
                <p className={`text-xs mb-2 ${isExpired ? 'text-red-600 font-medium' : isExpiringSoon ? 'text-amber-600 font-medium' : 'text-gray-400'}`}>
                  {isExpired ? '⚠️ Scaduto' : isExpiringSoon ? '⚠️ In scadenza'  : 'Scade'}: {d.expiryDate}
                </p>
              )}
              {d.notes && <p className="text-xs text-gray-500 mb-3 italic">{d.notes}</p>}
              <div className="flex gap-2 pt-3 border-t border-gray-100">
                <button onClick={() => openEdit(d)} className="flex-1 flex items-center justify-center gap-1 text-xs text-gray-600 hover:text-orange-600 py-1.5 hover:bg-orange-50 rounded-lg">
                  <Edit2 size={12} /> Modifica
                </button>
                <button onClick={() => del(d.id)} className="flex items-center justify-center px-3 py-1.5 text-xs text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          )
        })}
        {filtered.length === 0 && (
          <div className="col-span-3 text-center py-16 text-gray-400">
            <FileText size={48} className="mx-auto mb-2 opacity-30" />
            <p>Nessun documento trovato</p>
          </div>
        )}
      </div>

      {modal && (
        <Modal title={editing ? 'Modifica Documento' : 'Nuovo Documento'} onClose={() => setModal(false)} size="lg">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Input label="Nome Documento" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <Select label="Categoria" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value as any }))}
              options={CATEGORY_OPTIONS.map(c => ({ value: c.value, label: c.label }))} />
            <Input label="Tipo File" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} placeholder="PDF, DWG, DOC..." />
            <Select label="Progetto (opzionale)" value={form.projectId} onChange={e => setForm(f => ({ ...f, projectId: e.target.value }))}
              options={[{ value: '', label: '-- Documento Aziendale --' }, ...state.projects.map(p => ({ value: p.id, label: p.name }))]} />
            <div />
            <Input label="Data Caricamento" type="date" value={form.uploadDate} onChange={e => setForm(f => ({ ...f, uploadDate: e.target.value }))} />
            <Input label="Data Scadenza (opzionale)" type="date" value={form.expiryDate} onChange={e => setForm(f => ({ ...f, expiryDate: e.target.value }))} />
            <div className="sm:col-span-2">
              <Textarea label="Note" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} />
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
