import { useState } from 'react'
import { useApp } from '../context/AppContext'
import type { Expense, ExpenseCategory } from '../types'
import { generateId } from '../utils/storage'
import Modal from '../components/ui/Modal'
import Badge from '../components/ui/Badge'
import { Input, Select, Textarea } from '../components/ui/FormField'
import { Plus, Search, Edit2, Trash2, Check } from 'lucide-react'

const CATEGORY_OPTIONS: { value: ExpenseCategory; label: string; color: 'blue' | 'orange' | 'purple' | 'green' | 'yellow' | 'red' | 'gray' }[] = [
  { value: 'materiali', label: 'Materiali', color: 'blue' },
  { value: 'manodopera', label: 'Manodopera', color: 'orange' },
  { value: 'attrezzature', label: 'Attrezzature', color: 'purple' },
  { value: 'noleggi', label: 'Noleggi', color: 'green' },
  { value: 'trasporti', label: 'Trasporti', color: 'yellow' },
  { value: 'subappalti', label: 'Subappalti', color: 'red' },
  { value: 'utenze', label: 'Utenze', color: 'gray' },
  { value: 'assicurazioni', label: 'Assicurazioni', color: 'gray' },
  { value: 'altro', label: 'Altro', color: 'gray' },
]

const empty = {
  projectId: '', category: 'materiali' as ExpenseCategory, description: '',
  amount: 0, date: new Date().toISOString().slice(0, 10), supplierId: '',
  approved: false, approvedBy: '', notes: ''
}

export default function Spese() {
  const { state, dispatch } = useApp()
  const [search, setSearch] = useState('')
  const [filterProject, setFilterProject] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [filterApproved, setFilterApproved] = useState('')
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState<Expense | null>(null)
  const [form, setForm] = useState(empty)

  const filtered = state.expenses.filter(e => {
    const matchSearch = !search || e.description.toLowerCase().includes(search.toLowerCase())
    const matchProject = !filterProject || e.projectId === filterProject
    const matchCategory = !filterCategory || e.category === filterCategory
    const matchApproved = !filterApproved || (filterApproved === 'yes' ? e.approved : !e.approved)
    return matchSearch && matchProject && matchCategory && matchApproved
  }).sort((a, b) => b.date.localeCompare(a.date))

  const totalFiltered = filtered.reduce((s, e) => s + e.amount, 0)
  const totalApproved = filtered.filter(e => e.approved).reduce((s, e) => s + e.amount, 0)
  const totalPending = filtered.filter(e => !e.approved).reduce((s, e) => s + e.amount, 0)

  function openNew() { setEditing(null); setForm(empty); setModal(true) }
  function openEdit(e: Expense) {
    setEditing(e)
    setForm({ projectId: e.projectId, category: e.category, description: e.description, amount: e.amount, date: e.date, supplierId: e.supplierId || '', approved: e.approved, approvedBy: e.approvedBy || '', notes: e.notes })
    setModal(true)
  }
  function save() {
    const now = new Date().toISOString()
    if (editing) dispatch({ type: 'UPDATE_EXPENSE', payload: { ...editing, ...form } })
    else dispatch({ type: 'ADD_EXPENSE', payload: { id: generateId(), ...form, createdAt: now } })
    setModal(false)
  }
  function approve(e: Expense) {
    dispatch({ type: 'UPDATE_EXPENSE', payload: { ...e, approved: true, approvedBy: 'Admin' } })
  }
  function del(id: string) { if (confirm('Eliminare questa spesa?')) dispatch({ type: 'DELETE_EXPENSE', payload: id }) }

  const fmt = (n: number) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' })

  // Stats by category
  const byCategory = CATEGORY_OPTIONS.map(cat => ({
    ...cat,
    total: state.expenses.filter(e => e.category === cat.value).reduce((s, e) => s + e.amount, 0)
  })).filter(c => c.total > 0).sort((a, b) => b.total - a.total)

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500 font-medium">Totale Spese</p>
          <p className="text-xl font-bold text-gray-800 mt-1">{fmt(totalFiltered)}</p>
        </div>
        <div className="bg-green-50 border border-green-200 rounded-xl p-4">
          <p className="text-xs text-green-600 font-medium">Approvate</p>
          <p className="text-xl font-bold text-green-700 mt-1">{fmt(totalApproved)}</p>
        </div>
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
          <p className="text-xs text-yellow-700 font-medium">In Attesa</p>
          <p className="text-xl font-bold text-yellow-700 mt-1">{fmt(totalPending)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        {/* Category breakdown */}
        <div className="lg:col-span-1 bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-sm font-semibold text-gray-700 mb-3">Per Categoria</p>
          <div className="space-y-2">
            {byCategory.map(cat => {
              const pct = totalFiltered > 0 ? (cat.total / totalFiltered) * 100 : 0
              return (
                <div key={cat.value}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-600">{cat.label}</span>
                    <span className="font-medium">{fmt(cat.total)}</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full">
                    <div className="h-full rounded-full bg-orange-400" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Expenses table */}
        <div className="lg:col-span-3 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca spesa..." className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" />
            </div>
            <select value={filterProject} onChange={e => setFilterProject(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">Tutti i progetti</option>
              {state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">Tutte categorie</option>
              {CATEGORY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <select value={filterApproved} onChange={e => setFilterApproved(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">Tutte</option>
              <option value="yes">Approvate</option>
              <option value="no">In attesa</option>
            </select>
            <button onClick={openNew} className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600 whitespace-nowrap">
              <Plus size={16} /> Nuova Spesa
            </button>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
            <table className="w-full text-sm min-w-[650px]">
              <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-3">Data</th>
                  <th className="text-left px-4 py-3">Descrizione</th>
                  <th className="text-left px-4 py-3">Categoria</th>
                  <th className="text-left px-4 py-3">Progetto</th>
                  <th className="text-right px-4 py-3">Importo</th>
                  <th className="text-left px-4 py-3">Stato</th>
                  <th className="text-right px-4 py-3">Azioni</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(e => {
                  const project = state.projects.find(p => p.id === e.projectId)
                  const catInfo = CATEGORY_OPTIONS.find(c => c.value === e.category)
                  return (
                    <tr key={e.id} className={`hover:bg-gray-50 ${!e.approved ? 'bg-yellow-50/30' : ''}`}>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{e.date}</td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-800">{e.description}</p>
                        {e.notes && <p className="text-xs text-gray-400">{e.notes}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <Badge label={catInfo?.label || e.category} color={catInfo?.color || 'gray'} />
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs max-w-32 truncate">{project?.name || '—'}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-800">{fmt(e.amount)}</td>
                      <td className="px-4 py-3">
                        {e.approved
                          ? <Badge label="Approvata" color="green" />
                          : <Badge label="In attesa" color="yellow" />
                        }
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          {!e.approved && (
                            <button onClick={() => approve(e)} title="Approva" className="p-1.5 text-gray-400 hover:text-green-500 hover:bg-green-50 rounded-lg"><Check size={13} /></button>
                          )}
                          <button onClick={() => openEdit(e)} className="p-1.5 text-gray-400 hover:text-orange-500 hover:bg-orange-50 rounded-lg"><Edit2 size={13} /></button>
                          <button onClick={() => del(e.id)} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {filtered.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-gray-400">Nessuna spesa trovata</td></tr>}
              </tbody>
              {filtered.length > 0 && (
                <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                  <tr>
                    <td colSpan={4} className="px-4 py-3 text-sm font-semibold text-gray-700">Totale filtrato</td>
                    <td className="px-4 py-3 text-right font-bold text-gray-800">{fmt(totalFiltered)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>

      {modal && (
        <Modal title={editing ? 'Modifica Spesa' : 'Nuova Spesa'} onClose={() => setModal(false)} size="lg">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Data" type="date" required value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            <Select label="Categoria" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value as ExpenseCategory }))}
              options={CATEGORY_OPTIONS.map(c => ({ value: c.value, label: c.label }))} />
            <div className="sm:col-span-2">
              <Input label="Descrizione" required value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <Input label="Importo (€)" type="number" required value={form.amount} onChange={e => setForm(f => ({ ...f, amount: +e.target.value }))} />
            <Select label="Progetto" value={form.projectId} onChange={e => setForm(f => ({ ...f, projectId: e.target.value }))}
              options={[{ value: '', label: '-- Nessuno --' }, ...state.projects.map(p => ({ value: p.id, label: p.name }))]} />
            <Select label="Fornitore" value={form.supplierId} onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))}
              options={[{ value: '', label: '-- Nessuno --' }, ...state.suppliers.map(s => ({ value: s.id, label: s.name }))]} />
            <div className="flex items-center gap-3 pt-5">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.approved} onChange={e => setForm(f => ({ ...f, approved: e.target.checked }))} className="w-4 h-4 rounded accent-orange-500" />
                <span className="text-sm text-gray-700">Approvata</span>
              </label>
            </div>
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
