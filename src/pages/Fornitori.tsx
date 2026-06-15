import { useState } from 'react'
import { useApp } from '../context/AppContext'
import type { Supplier } from '../types'
import { generateId } from '../utils/storage'
import Modal from '../components/ui/Modal'
import { Input, Select, Textarea } from '../components/ui/FormField'
import { Plus, Search, Edit2, Trash2, Phone, Mail, Star } from 'lucide-react'

const empty = {
  name: '', category: '', contactPerson: '', email: '', phone: '',
  address: '', city: '', vatNumber: '', paymentTerms: '', rating: 3, notes: ''
}

const CATEGORIES = ['Calcestruzzo', 'Ferro e acciaio', 'Materiali edili', 'Impianti elettrici', 'Impianti idraulici', 'Legname', 'Isolanti', 'Ceramiche', 'Pitture e vernici', 'Noleggio attrezzature', 'Trasporti', 'Altro']

export default function Fornitori() {
  const { state, dispatch } = useApp()
  const [search, setSearch] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [form, setForm] = useState(empty)

  const filtered = state.suppliers.filter(s => {
    const matchSearch = !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.city.toLowerCase().includes(search.toLowerCase())
    const matchCategory = !filterCategory || s.category === filterCategory
    return matchSearch && matchCategory
  })

  function openNew() { setEditing(null); setForm(empty); setModal(true) }
  function openEdit(s: Supplier) {
    setEditing(s)
    setForm({ name: s.name, category: s.category, contactPerson: s.contactPerson, email: s.email, phone: s.phone, address: s.address, city: s.city, vatNumber: s.vatNumber, paymentTerms: s.paymentTerms, rating: s.rating, notes: s.notes })
    setModal(true)
  }
  function save() {
    const now = new Date().toISOString()
    if (editing) dispatch({ type: 'UPDATE_SUPPLIER', payload: { ...editing, ...form } })
    else dispatch({ type: 'ADD_SUPPLIER', payload: { id: generateId(), ...form, createdAt: now } })
    setModal(false)
  }
  function del(id: string) { if (confirm('Eliminare questo fornitore?')) dispatch({ type: 'DELETE_SUPPLIER', payload: id }) }

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca fornitore..." className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" />
        </div>
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <option value="">Tutte le categorie</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button onClick={openNew} className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
          <Plus size={16} /> Nuovo Fornitore
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-5 py-3">Fornitore</th>
              <th className="text-left px-4 py-3">Categoria</th>
              <th className="text-left px-4 py-3">Referente</th>
              <th className="text-left px-4 py-3">Contatti</th>
              <th className="text-left px-4 py-3">Pagamento</th>
              <th className="text-left px-4 py-3">Rating</th>
              <th className="text-right px-5 py-3">Azioni</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map(s => (
              <tr key={s.id} className="hover:bg-gray-50">
                <td className="px-5 py-3">
                  <p className="font-medium text-gray-800">{s.name}</p>
                  <p className="text-xs text-gray-400">{s.city}</p>
                </td>
                <td className="px-4 py-3 text-gray-600">{s.category}</td>
                <td className="px-4 py-3 text-gray-600">{s.contactPerson}</td>
                <td className="px-4 py-3">
                  <div className="space-y-0.5">
                    {s.phone && <p className="text-xs text-gray-500 flex items-center gap-1"><Phone size={11} />{s.phone}</p>}
                    {s.email && <p className="text-xs text-gray-500 flex items-center gap-1"><Mail size={11} />{s.email}</p>}
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">{s.paymentTerms}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-0.5">
                    {[1,2,3,4,5].map(i => <Star key={i} size={13} className={i <= s.rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-200'} />)}
                  </div>
                </td>
                <td className="px-5 py-3">
                  <div className="flex justify-end gap-2">
                    <button onClick={() => openEdit(s)} className="p-1.5 text-gray-400 hover:text-orange-500 hover:bg-orange-50 rounded-lg"><Edit2 size={14} /></button>
                    <button onClick={() => del(s.id)} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={14} /></button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-gray-400">Nessun fornitore trovato</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal title={editing ? 'Modifica Fornitore' : 'Nuovo Fornitore'} onClose={() => setModal(false)} size="lg">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Nome Azienda" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            <Select label="Categoria" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              options={[{ value: '', label: '-- Seleziona --' }, ...CATEGORIES.map(c => ({ value: c, label: c }))]} />
            <Input label="Referente" value={form.contactPerson} onChange={e => setForm(f => ({ ...f, contactPerson: e.target.value }))} />
            <Input label="Partita IVA" value={form.vatNumber} onChange={e => setForm(f => ({ ...f, vatNumber: e.target.value }))} />
            <Input label="Telefono" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            <Input label="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            <Input label="Indirizzo" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
            <Input label="Città" value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} />
            <Input label="Termini di Pagamento" value={form.paymentTerms} onChange={e => setForm(f => ({ ...f, paymentTerms: e.target.value }))} placeholder="Es. 30 gg fm" />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Rating</label>
              <div className="flex gap-1">
                {[1,2,3,4,5].map(i => (
                  <button key={i} type="button" onClick={() => setForm(f => ({ ...f, rating: i }))}>
                    <Star size={24} className={i <= form.rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'} />
                  </button>
                ))}
              </div>
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
