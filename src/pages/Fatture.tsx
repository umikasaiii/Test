import { useState } from 'react'
import { useApp } from '../context/AppContext'
import type { Invoice, InvoiceItem, InvoiceStatus } from '../types'
import { generateId } from '../utils/storage'
import Modal from '../components/ui/Modal'
import Badge from '../components/ui/Badge'
import { Input, Select, Textarea } from '../components/ui/FormField'
import {
  Plus, Search, Edit2, Trash2, Eye, Printer, CheckCircle,
  Send, AlertCircle, XCircle, FileText, Plus as PlusIcon, Trash
} from 'lucide-react'

const STATUS_OPTIONS = [
  { value: 'bozza', label: 'Bozza' },
  { value: 'inviata', label: 'Inviata' },
  { value: 'pagata', label: 'Pagata' },
  { value: 'scaduta', label: 'Scaduta' },
  { value: 'annullata', label: 'Annullata' },
]
const STATUS_COLOR: Record<string, 'gray' | 'blue' | 'green' | 'red' | 'yellow'> = {
  bozza: 'gray', inviata: 'blue', pagata: 'green', scaduta: 'red', annullata: 'gray'
}
const STATUS_ICON: Record<string, React.ReactNode> = {
  bozza: <FileText size={14} className="text-gray-400" />,
  inviata: <Send size={14} className="text-blue-500" />,
  pagata: <CheckCircle size={14} className="text-green-500" />,
  scaduta: <AlertCircle size={14} className="text-red-500" />,
  annullata: <XCircle size={14} className="text-gray-400" />,
}

const VAT_RATES = [
  { value: '22', label: '22% (ordinaria)' },
  { value: '10', label: '10% (ridotta)' },
  { value: '4', label: '4% (super ridotta)' },
  { value: '0', label: '0% (esente)' },
]

const emptyItem = (): InvoiceItem => ({ id: generateId(), description: '', quantity: 1, unitPrice: 0, total: 0 })

const emptyInvoice = {
  number: '', clientId: '', projectId: '',
  issueDate: new Date().toISOString().slice(0, 10),
  dueDate: '', status: 'bozza' as InvoiceStatus,
  items: [emptyItem()] as InvoiceItem[],
  vatRate: 22,
  notes: '', paidDate: ''
}

function calcItem(item: InvoiceItem): InvoiceItem {
  return { ...item, total: item.quantity * item.unitPrice }
}

function nextInvoiceNumber(invoices: Invoice[]): string {
  const year = new Date().getFullYear()
  const nums = invoices.filter(i => i.number.startsWith(`FT-${year}-`)).map(i => parseInt(i.number.split('-')[2]) || 0)
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1
  return `FT-${year}-${String(next).padStart(3, '0')}`
}

export default function Fatture() {
  const { state, dispatch } = useApp()
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterClient, setFilterClient] = useState('')
  const [modal, setModal] = useState<'form' | 'detail' | 'print' | null>(null)
  const [editing, setEditing] = useState<Invoice | null>(null)
  const [detail, setDetail] = useState<Invoice | null>(null)
  const [form, setForm] = useState(emptyInvoice)

  const filtered = state.invoices.filter(i => {
    const client = state.clients.find(c => c.id === i.clientId)
    const matchSearch = !search || i.number.toLowerCase().includes(search.toLowerCase()) || client?.name.toLowerCase().includes(search.toLowerCase())
    const matchStatus = !filterStatus || i.status === filterStatus
    const matchClient = !filterClient || i.clientId === filterClient
    return matchSearch && matchStatus && matchClient
  })

  // Totali per status
  const totals = {
    fatturato: state.invoices.filter(i => i.status === 'pagata').reduce((s, i) => s + i.total, 0),
    daIncassare: state.invoices.filter(i => i.status === 'inviata').reduce((s, i) => s + i.total, 0),
    scaduto: state.invoices.filter(i => i.status === 'scaduta').reduce((s, i) => s + i.total, 0),
  }

  function openNew() {
    setEditing(null)
    setForm({ ...emptyInvoice, number: nextInvoiceNumber(state.invoices), items: [emptyItem()] })
    setModal('form')
  }
  function openEdit(inv: Invoice) {
    setEditing(inv)
    setForm({
      number: inv.number, clientId: inv.clientId, projectId: inv.projectId,
      issueDate: inv.issueDate, dueDate: inv.dueDate, status: inv.status,
      items: inv.items, vatRate: inv.vatRate, notes: inv.notes, paidDate: inv.paidDate || ''
    })
    setModal('form')
  }
  function openDetail(inv: Invoice) { setDetail(inv); setModal('detail') }

  function updateItem(idx: number, field: keyof InvoiceItem, value: string | number) {
    setForm(f => {
      const items = f.items.map((item, i) => {
        if (i !== idx) return item
        const updated = { ...item, [field]: value }
        return calcItem(updated)
      })
      return { ...f, items }
    })
  }
  function addItem() { setForm(f => ({ ...f, items: [...f.items, emptyItem()] })) }
  function removeItem(idx: number) { setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) })) }

  function calcTotals() {
    const subtotal = form.items.reduce((s, i) => s + i.total, 0)
    const vatAmount = subtotal * (form.vatRate / 100)
    const total = subtotal + vatAmount
    return { subtotal, vatAmount, total }
  }

  function save() {
    const now = new Date().toISOString()
    const { subtotal, vatAmount, total } = calcTotals()
    const payload: Invoice = {
      ...(editing || { id: generateId(), createdAt: now }),
      ...form,
      subtotal, vatAmount, total,
      paidDate: form.status === 'pagata' ? (form.paidDate || now.slice(0, 10)) : undefined,
    }
    if (editing) dispatch({ type: 'UPDATE_INVOICE', payload })
    else dispatch({ type: 'ADD_INVOICE', payload })
    setModal(null)
  }

  function markAsPaid(inv: Invoice) {
    dispatch({ type: 'UPDATE_INVOICE', payload: { ...inv, status: 'pagata', paidDate: new Date().toISOString().slice(0, 10) } })
  }

  function del(id: string) { if (confirm('Eliminare questa fattura?')) dispatch({ type: 'DELETE_INVOICE', payload: id }) }

  const fmt = (n: number) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' })

  const printInvoice = (inv: Invoice) => {
    setDetail(inv)
    setModal('print')
  }

  return (
    <div className="space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-green-50 border border-green-200 rounded-xl p-4">
          <p className="text-xs text-green-600 font-medium">Incassato</p>
          <p className="text-xl font-bold text-green-700 mt-1">{fmt(totals.fatturato)}</p>
          <p className="text-xs text-green-500">{state.invoices.filter(i => i.status === 'pagata').length} fatture pagate</p>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <p className="text-xs text-blue-600 font-medium">Da Incassare</p>
          <p className="text-xl font-bold text-blue-700 mt-1">{fmt(totals.daIncassare)}</p>
          <p className="text-xs text-blue-500">{state.invoices.filter(i => i.status === 'inviata').length} fatture inviate</p>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs text-red-600 font-medium">Scaduto</p>
          <p className="text-xl font-bold text-red-700 mt-1">{fmt(totals.scaduto)}</p>
          <p className="text-xs text-red-500">{state.invoices.filter(i => i.status === 'scaduta').length} fatture scadute</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca per numero o cliente..." className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <option value="">Tutti gli stati</option>
          {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={filterClient} onChange={e => setFilterClient(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <option value="">Tutti i clienti</option>
          {state.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={openNew} className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600 whitespace-nowrap">
          <Plus size={16} /> Nuova Fattura
        </button>
      </div>

      {/* Invoice table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[750px]">
          <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-3">Numero</th>
              <th className="text-left px-4 py-3">Cliente</th>
              <th className="text-left px-4 py-3">Progetto</th>
              <th className="text-left px-4 py-3">Emissione</th>
              <th className="text-left px-4 py-3">Scadenza</th>
              <th className="text-right px-4 py-3">Imponibile</th>
              <th className="text-right px-4 py-3">IVA</th>
              <th className="text-right px-4 py-3">Totale</th>
              <th className="text-left px-4 py-3">Stato</th>
              <th className="text-right px-4 py-3">Azioni</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map(inv => {
              const client = state.clients.find(c => c.id === inv.clientId)
              const project = state.projects.find(p => p.id === inv.projectId)
              const isOverdue = inv.status === 'scaduta'
              return (
                <tr key={inv.id} className={`hover:bg-gray-50 ${isOverdue ? 'bg-red-50/40' : ''}`}>
                  <td className="px-4 py-3 font-mono font-medium text-gray-800">{inv.number}</td>
                  <td className="px-4 py-3 text-gray-700">{client?.name || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs max-w-32 truncate">{project?.name || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{inv.issueDate}</td>
                  <td className={`px-4 py-3 ${isOverdue ? 'text-red-600 font-medium' : 'text-gray-500'}`}>{inv.dueDate || '—'}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmt(inv.subtotal)}</td>
                  <td className="px-4 py-3 text-right text-gray-500">{fmt(inv.vatAmount)}</td>
                  <td className="px-4 py-3 text-right font-bold text-gray-800">{fmt(inv.total)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {STATUS_ICON[inv.status]}
                      <Badge label={STATUS_OPTIONS.find(s => s.value === inv.status)?.label || inv.status} color={STATUS_COLOR[inv.status]} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => openDetail(inv)} title="Dettaglio" className="p-1.5 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded-lg"><Eye size={13} /></button>
                      <button onClick={() => printInvoice(inv)} title="Stampa" className="p-1.5 text-gray-400 hover:text-purple-500 hover:bg-purple-50 rounded-lg"><Printer size={13} /></button>
                      {inv.status !== 'pagata' && inv.status !== 'annullata' && (
                        <button onClick={() => markAsPaid(inv)} title="Segna come pagata" className="p-1.5 text-gray-400 hover:text-green-500 hover:bg-green-50 rounded-lg"><CheckCircle size={13} /></button>
                      )}
                      <button onClick={() => openEdit(inv)} className="p-1.5 text-gray-400 hover:text-orange-500 hover:bg-orange-50 rounded-lg"><Edit2 size={13} /></button>
                      <button onClick={() => del(inv.id)} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && <tr><td colSpan={10} className="text-center py-8 text-gray-400">Nessuna fattura trovata</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Form Modal */}
      {modal === 'form' && (
        <Modal title={editing ? `Modifica ${editing.number}` : 'Nuova Fattura'} onClose={() => setModal(null)} size="xl">
          <div className="space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <Input label="Numero Fattura" required value={form.number} onChange={e => setForm(f => ({ ...f, number: e.target.value }))} />
              <Select label="Stato" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as InvoiceStatus }))} options={STATUS_OPTIONS} />
              <Select label="Aliquota IVA" value={String(form.vatRate)} onChange={e => setForm(f => ({ ...f, vatRate: +e.target.value }))} options={VAT_RATES} />
              <Select label="Cliente" required value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}
                options={[{ value: '', label: '-- Seleziona cliente --' }, ...state.clients.map(c => ({ value: c.id, label: c.name }))]} />
              <Select label="Progetto" value={form.projectId} onChange={e => setForm(f => ({ ...f, projectId: e.target.value }))}
                options={[{ value: '', label: '-- Nessuno --' }, ...state.projects.map(p => ({ value: p.id, label: p.name }))]} />
              <div />
              <Input label="Data Emissione" type="date" required value={form.issueDate} onChange={e => setForm(f => ({ ...f, issueDate: e.target.value }))} />
              <Input label="Data Scadenza" type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
              {form.status === 'pagata' && (
                <Input label="Data Pagamento" type="date" value={form.paidDate} onChange={e => setForm(f => ({ ...f, paidDate: e.target.value }))} />
              )}
            </div>

            {/* Line items */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-gray-700">Voci Fattura</p>
                <button onClick={addItem} className="flex items-center gap-1 text-xs text-orange-500 hover:text-orange-600 font-medium">
                  <PlusIcon size={13} /> Aggiungi riga
                </button>
              </div>
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-xs">
                    <tr>
                      <th className="text-left px-3 py-2">Descrizione</th>
                      <th className="text-right px-3 py-2 w-20">Qtà</th>
                      <th className="text-right px-3 py-2 w-28">Prezzo Unit.</th>
                      <th className="text-right px-3 py-2 w-28">Totale</th>
                      <th className="w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {form.items.map((item, idx) => (
                      <tr key={item.id}>
                        <td className="px-3 py-2">
                          <input value={item.description} onChange={e => updateItem(idx, 'description', e.target.value)}
                            className="w-full border-0 bg-transparent focus:outline-none text-sm text-gray-700 placeholder-gray-300"
                            placeholder="Descrizione prestazione..." />
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" value={item.quantity} onChange={e => updateItem(idx, 'quantity', +e.target.value)}
                            className="w-full border border-gray-200 rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-orange-400" min="1" />
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" value={item.unitPrice} onChange={e => updateItem(idx, 'unitPrice', +e.target.value)}
                            className="w-full border border-gray-200 rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-orange-400" min="0" step="0.01" />
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-gray-700">
                          {(item.quantity * item.unitPrice).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' })}
                        </td>
                        <td className="px-2 py-2">
                          {form.items.length > 1 && (
                            <button onClick={() => removeItem(idx)} className="text-gray-300 hover:text-red-400"><Trash size={14} /></button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Totals */}
            {(() => {
              const { subtotal, vatAmount, total } = calcTotals()
              return (
                <div className="flex justify-end">
                  <div className="bg-gray-50 rounded-xl p-4 w-72 space-y-2 text-sm">
                    <div className="flex justify-between text-gray-600">
                      <span>Imponibile</span>
                      <span className="font-medium">{fmt(subtotal)}</span>
                    </div>
                    <div className="flex justify-between text-gray-600">
                      <span>IVA {form.vatRate}%</span>
                      <span className="font-medium">{fmt(vatAmount)}</span>
                    </div>
                    <div className="flex justify-between text-gray-800 font-bold text-base pt-2 border-t border-gray-200">
                      <span>Totale</span>
                      <span>{fmt(total)}</span>
                    </div>
                  </div>
                </div>
              )
            })()}

            <Textarea label="Note" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} />
          </div>

          <div className="flex justify-end gap-3 mt-5 pt-4 border-t border-gray-100">
            <button onClick={() => setModal(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Annulla</button>
            <button onClick={save} className="px-5 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600">Salva Fattura</button>
          </div>
        </Modal>
      )}

      {/* Detail Modal */}
      {modal === 'detail' && detail && (
        <Modal title={`Fattura ${detail.number}`} onClose={() => setModal(null)} size="lg">
          <InvoiceDetailView invoice={detail} state={state} fmt={fmt} />
          <div className="flex justify-between mt-5 pt-4 border-t border-gray-100">
            <button onClick={() => { setModal(null); setTimeout(() => printInvoice(detail), 100) }} className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
              <Printer size={14} /> Stampa
            </button>
            <div className="flex gap-3">
              {detail.status !== 'pagata' && detail.status !== 'annullata' && (
                <button onClick={() => { markAsPaid(detail); setModal(null) }} className="flex items-center gap-2 px-4 py-2 text-sm bg-green-500 text-white rounded-lg hover:bg-green-600">
                  <CheckCircle size={14} /> Segna Pagata
                </button>
              )}
              <button onClick={() => { openEdit(detail); }} className="flex items-center gap-2 px-4 py-2 text-sm bg-orange-500 text-white rounded-lg hover:bg-orange-600">
                <Edit2 size={14} /> Modifica
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Print Modal */}
      {modal === 'print' && detail && (
        <Modal title="Anteprima Stampa" onClose={() => setModal(null)} size="xl">
          <InvoicePrintView invoice={detail} state={state} fmt={fmt} />
          <div className="flex justify-end mt-5 pt-4 border-t border-gray-100">
            <button onClick={() => window.print()} className="flex items-center gap-2 px-5 py-2 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-700">
              <Printer size={14} /> Stampa / PDF
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function InvoiceDetailView({ invoice: inv, state, fmt }: { invoice: Invoice; state: any; fmt: (n: number) => string }) {
  const client = state.clients.find((c: any) => c.id === inv.clientId)
  const project = state.projects.find((p: any) => p.id === inv.projectId)
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div><p className="text-gray-400">Cliente</p><p className="font-semibold text-gray-800">{client?.name}</p><p className="text-gray-500">{client?.address}, {client?.city}</p></div>
        <div>
          <div className="grid grid-cols-2 gap-2">
            <div><p className="text-gray-400">Numero</p><p className="font-mono font-medium">{inv.number}</p></div>
            <div><p className="text-gray-400">Stato</p><Badge label={inv.status} color={{ bozza: 'gray', inviata: 'blue', pagata: 'green', scaduta: 'red', annullata: 'gray' }[inv.status] as any} /></div>
            <div><p className="text-gray-400">Emissione</p><p>{inv.issueDate}</p></div>
            <div><p className="text-gray-400">Scadenza</p><p>{inv.dueDate || '—'}</p></div>
          </div>
        </div>
      </div>
      {project && <p className="text-sm text-gray-500">Progetto: <span className="font-medium text-gray-700">{project.name}</span></p>}
      <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left px-3 py-2 text-gray-500">Descrizione</th>
            <th className="text-right px-3 py-2 text-gray-500">Qtà</th>
            <th className="text-right px-3 py-2 text-gray-500">Prezzo</th>
            <th className="text-right px-3 py-2 text-gray-500">Totale</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {inv.items.map(item => (
            <tr key={item.id}>
              <td className="px-3 py-2 text-gray-700">{item.description}</td>
              <td className="px-3 py-2 text-right text-gray-600">{item.quantity}</td>
              <td className="px-3 py-2 text-right text-gray-600">{fmt(item.unitPrice)}</td>
              <td className="px-3 py-2 text-right font-medium text-gray-800">{fmt(item.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex justify-end">
        <div className="w-64 space-y-1.5 text-sm">
          <div className="flex justify-between"><span className="text-gray-500">Imponibile</span><span>{fmt(inv.subtotal)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">IVA {inv.vatRate}%</span><span>{fmt(inv.vatAmount)}</span></div>
          <div className="flex justify-between font-bold text-base pt-1 border-t"><span>Totale</span><span>{fmt(inv.total)}</span></div>
        </div>
      </div>
      {inv.paidDate && <p className="text-sm text-green-600">Pagata il {inv.paidDate}</p>}
      {inv.notes && <p className="text-sm text-gray-500 italic">{inv.notes}</p>}
    </div>
  )
}

function InvoicePrintView({ invoice: inv, state, fmt }: { invoice: Invoice; state: any; fmt: (n: number) => string }) {
  const client = state.clients.find((c: any) => c.id === inv.clientId)
  const project = state.projects.find((p: any) => p.id === inv.projectId)
  return (
    <div className="bg-white p-8 text-sm font-sans" id="print-area">
      <div className="flex justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">EdilGestionale Srl</h1>
          <p className="text-gray-500">Via del Cantiere 1 — 20100 Milano</p>
          <p className="text-gray-500">P.IVA: IT12345678901 — Tel: 02 1234567</p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-bold text-orange-500">FATTURA</p>
          <p className="text-lg font-mono font-semibold text-gray-700">{inv.number}</p>
          <p className="text-gray-500">Data: {inv.issueDate}</p>
          {inv.dueDate && <p className="text-gray-500">Scadenza: {inv.dueDate}</p>}
        </div>
      </div>

      <div className="mb-8 p-4 bg-gray-50 rounded-lg">
        <p className="text-xs text-gray-400 uppercase font-semibold mb-1">Destinatario</p>
        <p className="font-semibold text-gray-800">{client?.name}</p>
        <p className="text-gray-600">{client?.address}, {client?.city} {client?.zipCode}</p>
        {client?.fiscalCode && <p className="text-gray-500">CF: {client.fiscalCode}</p>}
        {client?.vatNumber && <p className="text-gray-500">P.IVA: {client.vatNumber}</p>}
      </div>

      {project && <p className="mb-4 text-gray-600">Rif. Lavori: <span className="font-medium">{project.name} — {project.address}, {project.city}</span></p>}

      <table className="w-full mb-6 border-collapse">
        <thead>
          <tr className="border-b-2 border-gray-300">
            <th className="text-left py-2 text-gray-600">Descrizione</th>
            <th className="text-right py-2 w-16 text-gray-600">Qtà</th>
            <th className="text-right py-2 w-28 text-gray-600">Prezzo Unit.</th>
            <th className="text-right py-2 w-28 text-gray-600">Importo</th>
          </tr>
        </thead>
        <tbody>
          {inv.items.map(item => (
            <tr key={item.id} className="border-b border-gray-100">
              <td className="py-2.5 text-gray-700">{item.description}</td>
              <td className="py-2.5 text-right text-gray-600">{item.quantity}</td>
              <td className="py-2.5 text-right text-gray-600">{fmt(item.unitPrice)}</td>
              <td className="py-2.5 text-right font-medium">{fmt(item.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex justify-end">
        <div className="w-72 space-y-2">
          <div className="flex justify-between text-gray-600">
            <span>Imponibile</span><span>{fmt(inv.subtotal)}</span>
          </div>
          <div className="flex justify-between text-gray-600">
            <span>IVA {inv.vatRate}%</span><span>{fmt(inv.vatAmount)}</span>
          </div>
          <div className="flex justify-between font-bold text-lg pt-2 border-t-2 border-gray-300">
            <span>TOTALE</span><span>{fmt(inv.total)}</span>
          </div>
        </div>
      </div>

      {inv.notes && <div className="mt-6 p-3 bg-gray-50 rounded text-gray-600 text-xs">{inv.notes}</div>}

      <div className="mt-8 pt-4 border-t border-gray-200 text-xs text-gray-400">
        Pagamento: bonifico bancario — IBAN: IT60 X054 2811 1010 0000 0123 456 — Banca Intesa San Paolo
      </div>
    </div>
  )
}
