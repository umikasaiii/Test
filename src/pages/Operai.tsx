import { useState } from 'react'
import { useApp } from '../context/AppContext'
import type { Worker, Attendance, WorkerRole } from '../types'
import { generateId } from '../utils/storage'
import Modal from '../components/ui/Modal'
import Badge from '../components/ui/Badge'
import { Input, Select, Textarea } from '../components/ui/FormField'
import { Plus, Search, Edit2, Trash2, UserCheck, Calendar, Euro, X, Check } from 'lucide-react'

const ROLE_OPTIONS: { value: WorkerRole; label: string }[] = [
  { value: 'capocantiere', label: 'Capocantiere' },
  { value: 'muratore', label: 'Muratore' },
  { value: 'carpentiere', label: 'Carpentiere' },
  { value: 'elettricista', label: 'Elettricista' },
  { value: 'idraulico', label: 'Idraulico' },
  { value: 'imbianchino', label: 'Imbianchino' },
  { value: 'operaio', label: 'Operaio Generico' },
  { value: 'geometra', label: 'Geometra' },
  { value: 'ingegnere', label: 'Ingegnere' },
  { value: 'altro', label: 'Altro' },
]

type ContractType = 'dipendente' | 'partita_iva' | 'subappaltatore'
const emptyWorker: { firstName: string; lastName: string; role: WorkerRole; phone: string; email: string; fiscalCode: string; contractType: ContractType; dailyRate: number; hireDate: string; active: boolean; address: string; city: string; emergencyContact: string; certifications: string[]; notes: string } = {
  firstName: '', lastName: '', role: 'operaio', phone: '', email: '',
  fiscalCode: '', contractType: 'dipendente', dailyRate: 0, hireDate: '',
  active: true, address: '', city: '', emergencyContact: '', certifications: [], notes: ''
}

const ATTENDANCE_STATUS = [
  { value: 'presente', label: 'Presente', color: 'green' as const },
  { value: 'assente', label: 'Assente', color: 'red' as const },
  { value: 'ferie', label: 'Ferie', color: 'blue' as const },
  { value: 'malattia', label: 'Malattia', color: 'yellow' as const },
  { value: 'permesso', label: 'Permesso', color: 'gray' as const },
]

export default function Operai() {
  const { state, dispatch } = useApp()
  const [tab, setTab] = useState<'operai' | 'presenze'>('operai')
  const [search, setSearch] = useState('')
  const [filterRole, setFilterRole] = useState('')
  const [modal, setModal] = useState<'form' | 'attendance' | null>(null)
  const [editing, setEditing] = useState<Worker | null>(null)
  const [form, setForm] = useState(emptyWorker)
  const [certInput, setCertInput] = useState('')
  const [attendanceDate, setAttendanceDate] = useState(new Date().toISOString().slice(0, 10))
  const [attendanceForms, setAttendanceForms] = useState<Record<string, { projectId: string; status: string; hoursWorked: number; overtime: number; notes: string }>>({})

  const filtered = state.workers.filter(w => {
    const matchSearch = !search || `${w.firstName} ${w.lastName}`.toLowerCase().includes(search.toLowerCase())
    const matchRole = !filterRole || w.role === filterRole
    return matchSearch && matchRole
  })

  function openNew() {
    setEditing(null)
    setForm(emptyWorker)
    setModal('form')
  }
  function openEdit(w: Worker) {
    setEditing(w)
    setForm({ firstName: w.firstName, lastName: w.lastName, role: w.role, phone: w.phone, email: w.email, fiscalCode: w.fiscalCode, contractType: w.contractType, dailyRate: w.dailyRate, hireDate: w.hireDate, active: w.active, address: w.address, city: w.city, emergencyContact: w.emergencyContact, certifications: [...w.certifications], notes: w.notes })
    setModal('form')
  }

  function openAttendance() {
    const forms: typeof attendanceForms = {}
    state.workers.filter(w => w.active).forEach(w => {
      const existing = state.attendances.find(a => a.workerId === w.id && a.date === attendanceDate)
      forms[w.id] = existing
        ? { projectId: existing.projectId, status: existing.status, hoursWorked: existing.hoursWorked, overtime: existing.overtime, notes: existing.notes }
        : { projectId: state.projects[0]?.id || '', status: 'presente', hoursWorked: 8, overtime: 0, notes: '' }
    })
    setAttendanceForms(forms)
    setModal('attendance')
  }

  function saveWorker() {
    const now = new Date().toISOString()
    if (editing) {
      dispatch({ type: 'UPDATE_WORKER', payload: { ...editing, ...form, updatedAt: now } as Worker })
    } else {
      dispatch({ type: 'ADD_WORKER', payload: { id: generateId(), ...form, createdAt: now } as Worker })
    }
    setModal(null)
  }

  function saveAttendances() {
    state.workers.filter(w => w.active).forEach(w => {
      const f = attendanceForms[w.id]
      if (!f) return
      const existing = state.attendances.find(a => a.workerId === w.id && a.date === attendanceDate)
      if (existing) {
        dispatch({ type: 'UPDATE_ATTENDANCE', payload: { ...existing, ...f } as Attendance })
      } else {
        dispatch({ type: 'ADD_ATTENDANCE', payload: { id: generateId(), workerId: w.id, date: attendanceDate, ...f } as Attendance })
      }
    })
    setModal(null)
  }

  function delWorker(id: string) {
    if (confirm('Eliminare questo operaio?')) dispatch({ type: 'DELETE_WORKER', payload: id })
  }

  const fmt = (n: number) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' })

  return (
    <div className="space-y-5">
      <div className="flex gap-3 border-b border-gray-200 pb-3">
        <button onClick={() => setTab('operai')} className={`px-4 py-2 text-sm font-medium rounded-lg ${tab === 'operai' ? 'bg-orange-100 text-orange-700' : 'text-gray-600 hover:bg-gray-100'}`}>Anagrafica Operai</button>
        <button onClick={() => setTab('presenze')} className={`px-4 py-2 text-sm font-medium rounded-lg ${tab === 'presenze' ? 'bg-orange-100 text-orange-700' : 'text-gray-600 hover:bg-gray-100'}`}>Registro Presenze</button>
      </div>

      {tab === 'operai' && (
        <>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca operaio..." className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" />
            </div>
            <select value={filterRole} onChange={e => setFilterRole(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400">
              <option value="">Tutte le qualifiche</option>
              {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <button onClick={openNew} className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
              <Plus size={16} /> Nuovo Operaio
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map(w => {
              const projects = state.projects.filter(p => p.workers.includes(w.id) && p.status === 'in_corso')
              const monthAttendances = state.attendances.filter(a => a.workerId === w.id && a.date.startsWith(new Date().toISOString().slice(0, 7)))
              const totalHours = monthAttendances.reduce((s, a) => s + a.hoursWorked + a.overtime, 0)
              return (
                <div key={w.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0 ${w.active ? 'bg-orange-500' : 'bg-gray-400'}`}>
                        {w.firstName[0]}{w.lastName[0]}
                      </div>
                      <div>
                        <p className="font-semibold text-gray-800 text-sm">{w.firstName} {w.lastName}</p>
                        <p className="text-xs text-gray-500">{ROLE_OPTIONS.find(r => r.value === w.role)?.label}</p>
                      </div>
                    </div>
                    <Badge label={w.active ? 'Attivo' : 'Inattivo'} color={w.active ? 'green' : 'gray'} />
                  </div>

                  <div className="space-y-1 text-xs text-gray-500 mb-3">
                    {w.phone && <div>{w.phone}</div>}
                    {w.email && <div>{w.email}</div>}
                    <div className="flex items-center gap-1"><Euro size={11} /> {fmt(w.dailyRate)}/giorno • {w.contractType}</div>
                    <div className="flex items-center gap-1"><Calendar size={11} /> Assunto: {w.hireDate}</div>
                    {projects.length > 0 && <div className="text-blue-600">Cantieri attivi: {projects.length}</div>}
                    <div>Ore questo mese: <span className="font-medium text-gray-700">{totalHours}h</span></div>
                  </div>

                  {w.certifications.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-3">
                      {w.certifications.map(c => <span key={c} className="bg-blue-50 text-blue-600 text-xs px-1.5 py-0.5 rounded">{c}</span>)}
                    </div>
                  )}

                  <div className="flex gap-2 pt-3 border-t border-gray-100">
                    <button onClick={() => openEdit(w)} className="flex-1 flex items-center justify-center gap-1 text-xs text-gray-600 hover:text-orange-600 py-1.5 hover:bg-orange-50 rounded-lg">
                      <Edit2 size={13} /> Modifica
                    </button>
                    <button onClick={() => delWorker(w.id)} className="flex items-center justify-center text-xs text-gray-400 hover:text-red-500 px-3 py-1.5 hover:bg-red-50 rounded-lg">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {tab === 'presenze' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Input label="" type="date" value={attendanceDate} onChange={e => setAttendanceDate(e.target.value)} className="!w-auto" />
              <p className="text-sm text-gray-500">{state.attendances.filter(a => a.date === attendanceDate && a.status === 'presente').length} presenti</p>
            </div>
            <button onClick={openAttendance} className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
              <UserCheck size={16} /> Registra Presenze
            </button>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-3">Operaio</th>
                  <th className="text-left px-4 py-3">Data</th>
                  <th className="text-left px-4 py-3">Stato</th>
                  <th className="text-left px-4 py-3">Ore</th>
                  <th className="text-left px-4 py-3">Straordinari</th>
                  <th className="text-left px-4 py-3">Cantiere</th>
                  <th className="text-left px-4 py-3">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {state.attendances.filter(a => a.date === attendanceDate).map(a => {
                  const worker = state.workers.find(w => w.id === a.workerId)
                  const project = state.projects.find(p => p.id === a.projectId)
                  const statusInfo = ATTENDANCE_STATUS.find(s => s.value === a.status)
                  return (
                    <tr key={a.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-800">{worker ? `${worker.firstName} ${worker.lastName}` : '—'}</td>
                      <td className="px-4 py-3 text-gray-500">{a.date}</td>
                      <td className="px-4 py-3"><Badge label={statusInfo?.label || a.status} color={statusInfo?.color || 'gray'} /></td>
                      <td className="px-4 py-3 text-gray-700">{a.hoursWorked}h</td>
                      <td className="px-4 py-3 text-gray-700">{a.overtime > 0 ? `+${a.overtime}h` : '—'}</td>
                      <td className="px-4 py-3 text-gray-500 truncate max-w-32">{project?.name || '—'}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{a.notes || '—'}</td>
                    </tr>
                  )
                })}
                {state.attendances.filter(a => a.date === attendanceDate).length === 0 && (
                  <tr><td colSpan={7} className="text-center py-8 text-gray-400">Nessuna presenza registrata per questa data</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Worker Form Modal */}
      {modal === 'form' && (
        <Modal title={editing ? 'Modifica Operaio' : 'Nuovo Operaio'} onClose={() => setModal(null)} size="xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Nome" required value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} />
            <Input label="Cognome" required value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} />
            <Select label="Qualifica" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as WorkerRole }))} options={ROLE_OPTIONS} />
            <Select label="Tipo Contratto" value={form.contractType} onChange={e => setForm(f => ({ ...f, contractType: e.target.value as any }))}
              options={[{ value: 'dipendente', label: 'Dipendente' }, { value: 'partita_iva', label: 'P.IVA' }, { value: 'subappaltatore', label: 'Subappaltatore' }]} />
            <Input label="Telefono" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            <Input label="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            <Input label="Codice Fiscale" value={form.fiscalCode} onChange={e => setForm(f => ({ ...f, fiscalCode: e.target.value.toUpperCase() }))} />
            <Input label="Tariffa Giornaliera (€)" type="number" value={form.dailyRate} onChange={e => setForm(f => ({ ...f, dailyRate: +e.target.value }))} />
            <Input label="Data Assunzione" type="date" value={form.hireDate} onChange={e => setForm(f => ({ ...f, hireDate: e.target.value }))} />
            <Select label="Stato" value={form.active ? 'true' : 'false'} onChange={e => setForm(f => ({ ...f, active: e.target.value === 'true' }))}
              options={[{ value: 'true', label: 'Attivo' }, { value: 'false', label: 'Inattivo' }]} />
            <Input label="Indirizzo" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
            <Input label="Città" value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} />
            <div className="sm:col-span-2">
              <Input label="Contatto Emergenza" value={form.emergencyContact} onChange={e => setForm(f => ({ ...f, emergencyContact: e.target.value }))} placeholder="Nome e telefono" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Certificazioni</label>
              <div className="flex gap-2 mb-2">
                <input value={certInput} onChange={e => setCertInput(e.target.value)} placeholder="Es. PES, PAV, Primo Soccorso..." className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  onKeyDown={e => { if (e.key === 'Enter' && certInput.trim()) { setForm(f => ({ ...f, certifications: [...f.certifications, certInput.trim()] })); setCertInput('') } }} />
                <button type="button" onClick={() => { if (certInput.trim()) { setForm(f => ({ ...f, certifications: [...f.certifications, certInput.trim()] })); setCertInput('') } }} className="px-3 py-2 bg-gray-100 rounded-lg text-sm hover:bg-gray-200">Aggiungi</button>
              </div>
              <div className="flex flex-wrap gap-2">
                {form.certifications.map((c, i) => (
                  <span key={i} className="flex items-center gap-1 bg-blue-100 text-blue-700 text-xs px-2 py-1 rounded-full">
                    {c}
                    <button onClick={() => setForm(f => ({ ...f, certifications: f.certifications.filter((_, j) => j !== i) }))}><X size={11} /></button>
                  </span>
                ))}
              </div>
            </div>
            <div className="sm:col-span-2">
              <Textarea label="Note" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} />
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-5 pt-4 border-t border-gray-100">
            <button onClick={() => setModal(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Annulla</button>
            <button onClick={saveWorker} className="px-5 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600">Salva</button>
          </div>
        </Modal>
      )}

      {/* Attendance Modal */}
      {modal === 'attendance' && (
        <Modal title={`Presenze del ${attendanceDate}`} onClose={() => setModal(null)} size="xl">
          <div className="space-y-3">
            {state.workers.filter(w => w.active).map(w => {
              const f = attendanceForms[w.id] || { projectId: '', status: 'presente', hoursWorked: 8, overtime: 0, notes: '' }
              return (
                <div key={w.id} className="grid grid-cols-2 sm:grid-cols-5 gap-3 p-3 bg-gray-50 rounded-xl items-end">
                  <div className="sm:col-span-1">
                    <p className="font-medium text-sm text-gray-800">{w.firstName} {w.lastName}</p>
                    <p className="text-xs text-gray-400">{ROLE_OPTIONS.find(r => r.value === w.role)?.label}</p>
                  </div>
                  <select value={f.status} onChange={e => setAttendanceForms(prev => ({ ...prev, [w.id]: { ...f, status: e.target.value } }))} className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-400">
                    {ATTENDANCE_STATUS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                  <select value={f.projectId} onChange={e => setAttendanceForms(prev => ({ ...prev, [w.id]: { ...f, projectId: e.target.value } }))} className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-400">
                    <option value="">-- Cantiere --</option>
                    {state.projects.filter(p => p.status === 'in_corso').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <div className="flex gap-1">
                    <input type="number" value={f.hoursWorked} min="0" max="12" onChange={e => setAttendanceForms(prev => ({ ...prev, [w.id]: { ...f, hoursWorked: +e.target.value } }))} className="w-16 border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-center focus:outline-none focus:ring-2 focus:ring-orange-400" placeholder="Ore" />
                    <input type="number" value={f.overtime} min="0" max="6" onChange={e => setAttendanceForms(prev => ({ ...prev, [w.id]: { ...f, overtime: +e.target.value } }))} className="w-16 border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-center focus:outline-none focus:ring-2 focus:ring-orange-400" placeholder="+Str" />
                  </div>
                  <input value={f.notes} onChange={e => setAttendanceForms(prev => ({ ...prev, [w.id]: { ...f, notes: e.target.value } }))} className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-400" placeholder="Note" />
                </div>
              )
            })}
          </div>
          <div className="flex justify-end gap-3 mt-5 pt-4 border-t border-gray-100">
            <button onClick={() => setModal(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Annulla</button>
            <button onClick={saveAttendances} className="flex items-center gap-2 px-5 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600">
              <Check size={16} /> Salva Presenze
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
