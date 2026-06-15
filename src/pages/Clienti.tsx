import { useState } from 'react'
import { useApp } from '../context/AppContext'
import type { Client } from '../types'
import { generateId } from '../utils/storage'
import Modal from '../components/ui/Modal'
import Badge from '../components/ui/Badge'
import { Input, Select, Textarea } from '../components/ui/FormField'
import { Plus, Search, Edit2, Trash2, Phone, Mail, MapPin, FolderKanban } from 'lucide-react'

const TYPE_OPTIONS = [
  { value: 'privato', label: 'Privato' },
  { value: 'azienda', label: 'Azienda' },
  { value: 'ente_pubblico', label: 'Ente Pubblico' },
]
const TYPE_COLOR: Record<string, 'blue' | 'orange' | 'purple'> = {
  privato: 'blue', azienda: 'orange', ente_pubblico: 'purple'
}

type ClientType = 'privato' | 'azienda' | 'ente_pubblico'
const empty: { type: ClientType; name: string; contactPerson: string; email: string; phone: string; address: string; city: string; zipCode: string; fiscalCode: string; vatNumber: string; notes: string } = {
  type: 'privato', name: '', contactPerson: '', email: '', phone: '',
  address: '', city: '', zipCode: '', fiscalCode: '', vatNumber: '', notes: ''
}

export default function Clienti() {
  const { state, dispatch } = useApp()
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState('')
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState<Client | null>(null)
  const [form, setForm] = useState(empty)

  const filtered = state.clients.filter(c => {
    const matchSearch = !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.city.toLowerCase().includes(search.toLowerCase())
    const matchType = !filterType || c.type === filterType
    return matchSearch && matchType
  })

  function openNew() { setEditing(null); setForm(empty); setModal(true) }
  function openEdit(c: Client) {
    setEditing(c)
    setForm({ type: c.type, name: c.name, contactPerson: c.contactPerson, email: c.email, phone: c.phone, address: c.address, city: c.city, zipCode: c.zipCode, fiscalCode: c.fiscalCode, vatNumber: c.vatNumber, notes: c.notes })
    setModal(true)
  }
  function save() {
    const now = new Date().toISOString()
    if (editing) dispatch({ type: 'UPDATE_CLIENT', payload: { ...editing, ...form } })
    else dispatch({ type: 'ADD_CLIENT', payload: { id: generateId(), ...form, createdAt: now } })
    setModal(false)
  }
  function del(id: string) { if (confirm('Eliminare questo cliente?')) dispatch({ type: 'DELETE_CLIENT', payload: id }) }

  const fmt = (n: number) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca cliente..." className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" />
        </div>
        <select value={filterType} onChange={e => setFilterType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <option value="">Tutti i tipi</option>
          {TYPE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <button onClick={openNew} className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
          <Plus size={16} /> Nuovo Cliente
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map(c => {
          const projects = state.projects.filter(p => p.clientId === c.id)
          const invoices = state.invoices.filter(i => i.clientId === c.id)
          const totalInvoiced = invoices.reduce((s, i) => s + i.total, 0)
          return (
            <div key={c.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-gray-800 text-sm">{c.name}</h3>
                  {c.contactPerson && c.contactPerson !== c.name && <p className="text-xs text-gray-500">{c.contactPerson}</p>}
                </div>
                <Badge label={TYPE_OPTIONS.find(t => t.value === c.type)?.label || c.type} color={TYPE_COLOR[c.type]} />
              </div>

              <div className="space-y-1.5 text-xs text-gray-500 mb-4">
                {c.phone && <div className="flex items-center gap-1.5"><Phone size={11} /> {c.phone}</div>}
                {c.email && <div className="flex items-center gap-1.5"><Mail size={11} /> {c.email}</div>}
                {(c.address || c.city) && <div className="flex items-center gap-1.5"><MapPin size={11} /> {[c.address, c.city].filter(Boolean).join(', ')}</div>}
                {c.fiscalCode && <div>CF: {c.fiscalCode}</div>}
                {c.vatNumber && <div>P.IVA: {c.vatNumber}</div>}
              </div>

              <div className="flex gap-3 text-center mb-3">
                <div className="flex-1 bg-blue-50 rounded-lg py-2">
                  <p className="text-sm font-bold text-blue-700 flex items-center justify-center gap-1"><FolderKanban size={13} />{projects.length}</p>
                  <p className="text-xs text-blue-500">Progetti</p>
                </div>
                <div className="flex-1 bg-green-50 rounded-lg py-2">
                  <p className="text-sm font-bold text-green-700">{fmt(totalInvoiced)}</p>
                  <p className="text-xs text-green-500">Fatturato</p>
                </div>
              </div>

              <div className="flex gap-2 pt-3 border-t border-gray-100">
                <button onClick={() => openEdit(c)} className="flex-1 flex items-center justify-center gap-1 text-xs text-gray-600 hover:text-orange-600 py-1.5 hover:bg-orange-50 rounded-lg">
                  <Edit2 size={13} /> Modifica
                </button>
                <button onClick={() => del(c.id)} className="flex items-center justify-center px-3 py-1.5 text-xs text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {modal && (
        <Modal title={editing ? 'Modifica Cliente' : 'Nuovo Cliente'} onClose={() => setModal(false)} size="lg">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select label="Tipo" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as any }))} options={TYPE_OPTIONS} />
            <Input label="Ragione Sociale / Nome" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            <Input label="Referente" value={form.contactPerson} onChange={e => setForm(f => ({ ...f, contactPerson: e.target.value }))} />
            <Input label="Telefono" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            <Input label="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            <div />
            <Input label="Indirizzo" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
            <Input label="Città" value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} />
            <Input label="CAP" value={form.zipCode} onChange={e => setForm(f => ({ ...f, zipCode: e.target.value }))} />
            <div />
            <Input label="Codice Fiscale" value={form.fiscalCode} onChange={e => setForm(f => ({ ...f, fiscalCode: e.target.value.toUpperCase() }))} />
            <Input label="Partita IVA" value={form.vatNumber} onChange={e => setForm(f => ({ ...f, vatNumber: e.target.value }))} />
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
