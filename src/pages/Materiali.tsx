import { useState } from 'react'
import { useApp } from '../context/AppContext'
import type { Material, MaterialOrder } from '../types'
import { generateId } from '../utils/storage'
import Modal from '../components/ui/Modal'
import Badge from '../components/ui/Badge'
import { Input, Select, Textarea } from '../components/ui/FormField'
import { Plus, Search, Edit2, Trash2, AlertTriangle, ShoppingCart } from 'lucide-react'

const MATERIAL_CATEGORIES = ['Calcestruzzo', 'Ferro e acciaio', 'Laterizi', 'Leganti', 'Inerti', 'Isolanti', 'Impianti elettrici', 'Impianti idraulici', 'Legname', 'Ceramiche', 'Pitture', 'Vetro', 'Altro']

const emptyMaterial = {
  name: '', category: '', unit: 'pz', unitPrice: 0, supplierId: '',
  stock: 0, minStock: 0, code: '', notes: ''
}

type OrderStatus = 'ordinato' | 'consegnato' | 'annullato'
const emptyOrder: { materialId: string; projectId: string; supplierId: string; quantity: number; unitPrice: number; orderDate: string; deliveryDate: string; status: OrderStatus; notes: string } = {
  materialId: '', projectId: '', supplierId: '', quantity: 1, unitPrice: 0,
  orderDate: new Date().toISOString().slice(0, 10), deliveryDate: '', status: 'ordinato', notes: ''
}

export default function Materiali() {
  const { state, dispatch } = useApp()
  const [tab, setTab] = useState<'magazzino' | 'ordini'>('magazzino')
  const [search, setSearch] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [modal, setModal] = useState<'material' | 'order' | null>(null)
  const [editingMaterial, setEditingMaterial] = useState<Material | null>(null)
  const [editingOrder, setEditingOrder] = useState<MaterialOrder | null>(null)
  const [form, setForm] = useState(emptyMaterial)
  const [orderForm, setOrderForm] = useState(emptyOrder)

  const filtered = state.materials.filter(m => {
    const matchSearch = !search || m.name.toLowerCase().includes(search.toLowerCase()) || m.code.toLowerCase().includes(search.toLowerCase())
    const matchCat = !filterCategory || m.category === filterCategory
    return matchSearch && matchCat
  })

  const lowStock = state.materials.filter(m => m.stock <= m.minStock)

  function openNewMaterial() { setEditingMaterial(null); setForm(emptyMaterial); setModal('material') }
  function openEditMaterial(m: Material) {
    setEditingMaterial(m)
    setForm({ name: m.name, category: m.category, unit: m.unit, unitPrice: m.unitPrice, supplierId: m.supplierId, stock: m.stock, minStock: m.minStock, code: m.code, notes: m.notes })
    setModal('material')
  }
  function openNewOrder(materialId = '') {
    const mat = state.materials.find(m => m.id === materialId)
    setEditingOrder(null)
    setOrderForm({ ...emptyOrder, materialId, supplierId: mat?.supplierId || '', unitPrice: mat?.unitPrice || 0 })
    setModal('order')
  }
  function openEditOrder(o: MaterialOrder) {
    setEditingOrder(o)
    setOrderForm({ materialId: o.materialId, projectId: o.projectId, supplierId: o.supplierId, quantity: o.quantity, unitPrice: o.unitPrice, orderDate: o.orderDate, deliveryDate: o.deliveryDate, status: o.status, notes: o.notes })
    setModal('order')
  }

  function saveMaterial() {
    const now = new Date().toISOString()
    if (editingMaterial) dispatch({ type: 'UPDATE_MATERIAL', payload: { ...editingMaterial, ...form } })
    else dispatch({ type: 'ADD_MATERIAL', payload: { id: generateId(), ...form, createdAt: now } })
    setModal(null)
  }

  function saveOrder() {
    const now = new Date().toISOString()
    const total = orderForm.quantity * orderForm.unitPrice
    if (editingOrder) dispatch({ type: 'UPDATE_MATERIAL_ORDER', payload: { ...editingOrder, ...orderForm, totalPrice: total } })
    else dispatch({ type: 'ADD_MATERIAL_ORDER', payload: { id: generateId(), ...orderForm, totalPrice: total, createdAt: now } })
    setModal(null)
  }

  function delMaterial(id: string) { if (confirm('Eliminare questo materiale?')) dispatch({ type: 'DELETE_MATERIAL', payload: id }) }
  function delOrder(id: string) { if (confirm('Eliminare questo ordine?')) dispatch({ type: 'DELETE_MATERIAL_ORDER', payload: id }) }

  const fmt = (n: number) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' })

  return (
    <div className="space-y-5">
      {lowStock.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="text-amber-500 flex-shrink-0 mt-0.5" size={18} />
          <div className="text-sm text-amber-700">
            <strong>{lowStock.length} materiale/i sotto la scorta minima:</strong> {lowStock.map(m => m.name).join(', ')}
          </div>
        </div>
      )}

      <div className="flex gap-3 border-b border-gray-200 pb-3">
        <button onClick={() => setTab('magazzino')} className={`px-4 py-2 text-sm font-medium rounded-lg ${tab === 'magazzino' ? 'bg-orange-100 text-orange-700' : 'text-gray-600 hover:bg-gray-100'}`}>Magazzino</button>
        <button onClick={() => setTab('ordini')} className={`px-4 py-2 text-sm font-medium rounded-lg ${tab === 'ordini' ? 'bg-orange-100 text-orange-700' : 'text-gray-600 hover:bg-gray-100'}`}>Ordini Materiali</button>
      </div>

      {tab === 'magazzino' && (
        <>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca materiale o codice..." className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" />
            </div>
            <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">Tutte le categorie</option>
              {MATERIAL_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <button onClick={openNewMaterial} className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
              <Plus size={16} /> Nuovo Materiale
            </button>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-3">Codice</th>
                  <th className="text-left px-4 py-3">Materiale</th>
                  <th className="text-left px-4 py-3">Categoria</th>
                  <th className="text-left px-4 py-3">Fornitore</th>
                  <th className="text-right px-4 py-3">Prezzo/UM</th>
                  <th className="text-right px-4 py-3">Scorta</th>
                  <th className="text-right px-4 py-3">Min.</th>
                  <th className="text-right px-4 py-3">Stato</th>
                  <th className="text-right px-4 py-3">Azioni</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(m => {
                  const supplier = state.suppliers.find(s => s.id === m.supplierId)
                  const isLow = m.stock <= m.minStock
                  return (
                    <tr key={m.id} className={`hover:bg-gray-50 ${isLow ? 'bg-amber-50/50' : ''}`}>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{m.code}</td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-800">{m.name}</p>
                        {m.notes && <p className="text-xs text-amber-600">{m.notes}</p>}
                      </td>
                      <td className="px-4 py-3 text-gray-500">{m.category}</td>
                      <td className="px-4 py-3 text-gray-500">{supplier?.name || '—'}</td>
                      <td className="px-4 py-3 text-right font-medium">{fmt(m.unitPrice)} / {m.unit}</td>
                      <td className={`px-4 py-3 text-right font-bold ${isLow ? 'text-red-600' : 'text-gray-700'}`}>{m.stock} {m.unit}</td>
                      <td className="px-4 py-3 text-right text-gray-400">{m.minStock} {m.unit}</td>
                      <td className="px-4 py-3 text-right">
                        {isLow ? <Badge label="Scorta Bassa" color="red" /> : <Badge label="OK" color="green" />}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => openNewOrder(m.id)} title="Ordina" className="p-1.5 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded-lg"><ShoppingCart size={13} /></button>
                          <button onClick={() => openEditMaterial(m)} className="p-1.5 text-gray-400 hover:text-orange-500 hover:bg-orange-50 rounded-lg"><Edit2 size={13} /></button>
                          <button onClick={() => delMaterial(m.id)} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {filtered.length === 0 && <tr><td colSpan={9} className="text-center py-8 text-gray-400">Nessun materiale trovato</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'ordini' && (
        <>
          <div className="flex justify-end">
            <button onClick={() => openNewOrder()} className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
              <ShoppingCart size={16} /> Nuovo Ordine
            </button>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-3">Materiale</th>
                  <th className="text-left px-4 py-3">Progetto</th>
                  <th className="text-left px-4 py-3">Fornitore</th>
                  <th className="text-right px-4 py-3">Quantità</th>
                  <th className="text-right px-4 py-3">Totale</th>
                  <th className="text-left px-4 py-3">Data Ordine</th>
                  <th className="text-left px-4 py-3">Consegna</th>
                  <th className="text-left px-4 py-3">Stato</th>
                  <th className="text-right px-4 py-3">Azioni</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {state.materialOrders.map(o => {
                  const material = state.materials.find(m => m.id === o.materialId)
                  const project = state.projects.find(p => p.id === o.projectId)
                  const supplier = state.suppliers.find(s => s.id === o.supplierId)
                  return (
                    <tr key={o.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-800">{material?.name || '—'}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{project?.name || '—'}</td>
                      <td className="px-4 py-3 text-gray-500">{supplier?.name || '—'}</td>
                      <td className="px-4 py-3 text-right">{o.quantity} {material?.unit}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-700">{fmt(o.totalPrice)}</td>
                      <td className="px-4 py-3 text-gray-500">{o.orderDate}</td>
                      <td className="px-4 py-3 text-gray-500">{o.deliveryDate || '—'}</td>
                      <td className="px-4 py-3">
                        <Badge label={o.status === 'ordinato' ? 'Ordinato' : o.status === 'consegnato' ? 'Consegnato' : 'Annullato'}
                          color={o.status === 'consegnato' ? 'green' : o.status === 'ordinato' ? 'blue' : 'red'} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => openEditOrder(o)} className="p-1.5 text-gray-400 hover:text-orange-500 hover:bg-orange-50 rounded-lg"><Edit2 size={13} /></button>
                          <button onClick={() => delOrder(o.id)} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {state.materialOrders.length === 0 && <tr><td colSpan={9} className="text-center py-8 text-gray-400">Nessun ordine</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {modal === 'material' && (
        <Modal title={editingMaterial ? 'Modifica Materiale' : 'Nuovo Materiale'} onClose={() => setModal(null)} size="lg">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Nome Materiale" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            <Input label="Codice" value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} />
            <Select label="Categoria" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              options={[{ value: '', label: '-- Seleziona --' }, ...MATERIAL_CATEGORIES.map(c => ({ value: c, label: c }))]} />
            <Select label="Fornitore" value={form.supplierId} onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))}
              options={[{ value: '', label: '-- Nessuno --' }, ...state.suppliers.map(s => ({ value: s.id, label: s.name }))]} />
            <Input label="Unità di Misura" value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} placeholder="pz, kg, m², m³..." />
            <Input label="Prezzo Unitario (€)" type="number" value={form.unitPrice} onChange={e => setForm(f => ({ ...f, unitPrice: +e.target.value }))} />
            <Input label="Scorta Attuale" type="number" value={form.stock} onChange={e => setForm(f => ({ ...f, stock: +e.target.value }))} />
            <Input label="Scorta Minima" type="number" value={form.minStock} onChange={e => setForm(f => ({ ...f, minStock: +e.target.value }))} />
            <div className="sm:col-span-2">
              <Textarea label="Note" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} />
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-5 pt-4 border-t border-gray-100">
            <button onClick={() => setModal(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Annulla</button>
            <button onClick={saveMaterial} className="px-5 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600">Salva</button>
          </div>
        </Modal>
      )}

      {modal === 'order' && (
        <Modal title={editingOrder ? 'Modifica Ordine' : 'Nuovo Ordine Materiale'} onClose={() => setModal(null)} size="lg">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select label="Materiale" required value={orderForm.materialId} onChange={e => {
              const mat = state.materials.find(m => m.id === e.target.value)
              setOrderForm(f => ({ ...f, materialId: e.target.value, supplierId: mat?.supplierId || f.supplierId, unitPrice: mat?.unitPrice || 0 }))
            }} options={[{ value: '', label: '-- Seleziona materiale --' }, ...state.materials.map(m => ({ value: m.id, label: m.name }))]} />
            <Select label="Progetto" value={orderForm.projectId} onChange={e => setOrderForm(f => ({ ...f, projectId: e.target.value }))}
              options={[{ value: '', label: '-- Nessuno --' }, ...state.projects.map(p => ({ value: p.id, label: p.name }))]} />
            <Select label="Fornitore" value={orderForm.supplierId} onChange={e => setOrderForm(f => ({ ...f, supplierId: e.target.value }))}
              options={[{ value: '', label: '-- Seleziona --' }, ...state.suppliers.map(s => ({ value: s.id, label: s.name }))]} />
            <Select label="Stato" value={orderForm.status} onChange={e => setOrderForm(f => ({ ...f, status: e.target.value as any }))}
              options={[{ value: 'ordinato', label: 'Ordinato' }, { value: 'consegnato', label: 'Consegnato' }, { value: 'annullato', label: 'Annullato' }]} />
            <Input label="Quantità" type="number" value={orderForm.quantity} onChange={e => setOrderForm(f => ({ ...f, quantity: +e.target.value }))} />
            <Input label="Prezzo Unitario (€)" type="number" value={orderForm.unitPrice} onChange={e => setOrderForm(f => ({ ...f, unitPrice: +e.target.value }))} />
            <Input label="Data Ordine" type="date" value={orderForm.orderDate} onChange={e => setOrderForm(f => ({ ...f, orderDate: e.target.value }))} />
            <Input label="Data Consegna Prevista" type="date" value={orderForm.deliveryDate} onChange={e => setOrderForm(f => ({ ...f, deliveryDate: e.target.value }))} />
            <div className="sm:col-span-2 bg-blue-50 rounded-lg p-3 text-sm">
              Totale ordine: <strong>{fmt(orderForm.quantity * orderForm.unitPrice)}</strong>
            </div>
            <div className="sm:col-span-2">
              <Textarea label="Note" value={orderForm.notes} onChange={e => setOrderForm(f => ({ ...f, notes: e.target.value }))} rows={2} />
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-5 pt-4 border-t border-gray-100">
            <button onClick={() => setModal(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Annulla</button>
            <button onClick={saveOrder} className="px-5 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600">Salva</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
