import { useState, useEffect } from 'react'
import type { Appointment, AppointmentType } from '../types/appointments'
import { useApp } from '../context/AppContext'
import Modal from '../components/ui/Modal'
import { Input, Select, Textarea } from '../components/ui/FormField'
import { ChevronLeft, ChevronRight, Plus, Clock, MapPin, Edit2, Trash2, Bell } from 'lucide-react'

const STORAGE_KEY = 'edile_appointments_v1'

function loadApps(): Appointment[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}
function saveApps(apps: Appointment[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(apps))
}
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7) }

const TYPE_META: Record<AppointmentType, { label: string; color: string; bg: string; dot: string }> = {
  sopralluogo: { label: 'Sopralluogo', color: 'text-blue-700', bg: 'bg-blue-100', dot: 'bg-blue-500' },
  riunione:    { label: 'Riunione',    color: 'text-purple-700', bg: 'bg-purple-100', dot: 'bg-purple-500' },
  collaudo:    { label: 'Collaudo',    color: 'text-green-700', bg: 'bg-green-100', dot: 'bg-green-500' },
  consegna:    { label: 'Consegna',    color: 'text-orange-700', bg: 'bg-orange-100', dot: 'bg-orange-500' },
  scadenza:    { label: 'Scadenza',    color: 'text-red-700', bg: 'bg-red-100', dot: 'bg-red-500' },
  altro:       { label: 'Altro',       color: 'text-gray-700', bg: 'bg-gray-100', dot: 'bg-gray-400' },
}

const DAYS_IT = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab']
const MONTHS_IT = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre']

const emptyForm: Omit<Appointment, 'id' | 'createdAt'> = {
  title: '', type: 'sopralluogo', date: new Date().toISOString().slice(0, 10),
  startTime: '09:00', endTime: '10:00', projectId: '', clientId: '',
  location: '', notes: '', reminder: false,
}

export default function Calendario() {
  const { state } = useApp()
  const [appointments, setAppointments] = useState<Appointment[]>(loadApps)
  const [today] = useState(new Date())
  const [current, setCurrent] = useState(new Date(today.getFullYear(), today.getMonth(), 1))
  const [modal, setModal] = useState<'form' | 'detail' | null>(null)
  const [editing, setEditing] = useState<Appointment | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [selected, setSelected] = useState<Appointment | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [view, setView] = useState<'month' | 'list'>('month')

  useEffect(() => { saveApps(appointments) }, [appointments])

  const year = current.getFullYear()
  const month = current.getMonth()
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const todayStr = today.toISOString().slice(0, 10)

  // Pad grid to start on Sunday
  const cells: (number | null)[] = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]
  while (cells.length % 7 !== 0) cells.push(null)

  function appsForDay(d: number) {
    const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    return appointments.filter(a => a.date === ds).sort((a, b) => a.startTime.localeCompare(b.startTime))
  }

  function openNew(date?: string) {
    setEditing(null)
    setForm({ ...emptyForm, date: date || todayStr })
    setModal('form')
  }
  function openEdit(a: Appointment) {
    setEditing(a)
    setForm({ title: a.title, type: a.type, date: a.date, startTime: a.startTime, endTime: a.endTime, projectId: a.projectId || '', clientId: a.clientId || '', location: a.location, notes: a.notes, reminder: a.reminder })
    setModal('form')
  }
  function openDetail(a: Appointment) { setSelected(a); setModal('detail') }

  function save() {
    const now = new Date().toISOString()
    if (editing) {
      setAppointments(prev => prev.map(a => a.id === editing.id ? { ...editing, ...form } : a))
    } else {
      setAppointments(prev => [...prev, { id: genId(), ...form, createdAt: now }])
    }
    setModal(null)
  }
  function del(id: string) {
    if (confirm('Eliminare questo appuntamento?')) {
      setAppointments(prev => prev.filter(a => a.id !== id))
      setModal(null)
    }
  }

  function dayStr(d: number) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }

  const upcomingApps = appointments
    .filter(a => a.date >= todayStr)
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
    .slice(0, 20)

  return (
    <div className="space-y-4">
      {/* Header controls */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <button onClick={() => setCurrent(new Date(year, month - 1, 1))} className="p-2 hover:bg-gray-100 rounded-lg">
            <ChevronLeft size={18} />
          </button>
          <h2 className="text-lg font-semibold text-gray-800 w-44 text-center">
            {MONTHS_IT[month]} {year}
          </h2>
          <button onClick={() => setCurrent(new Date(year, month + 1, 1))} className="p-2 hover:bg-gray-100 rounded-lg">
            <ChevronRight size={18} />
          </button>
          <button onClick={() => setCurrent(new Date(today.getFullYear(), today.getMonth(), 1))} className="text-xs px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 ml-1">
            Oggi
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-gray-100 rounded-lg p-1">
            <button onClick={() => setView('month')} className={`px-3 py-1 text-xs rounded-md transition-colors ${view === 'month' ? 'bg-white shadow font-medium' : 'text-gray-500'}`}>Mese</button>
            <button onClick={() => setView('list')} className={`px-3 py-1 text-xs rounded-md transition-colors ${view === 'list' ? 'bg-white shadow font-medium' : 'text-gray-500'}`}>Lista</button>
          </div>
          <button onClick={() => openNew()} className="flex items-center gap-2 bg-orange-500 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
            <Plus size={16} /> Nuovo
          </button>
        </div>
      </div>

      {view === 'month' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          {/* Day headers */}
          <div className="grid grid-cols-7 border-b border-gray-100">
            {DAYS_IT.map(d => (
              <div key={d} className="text-center py-2 text-xs font-semibold text-gray-500 uppercase">{d}</div>
            ))}
          </div>
          {/* Calendar grid */}
          <div className="grid grid-cols-7">
            {cells.map((day, idx) => {
              const ds = day ? dayStr(day) : ''
              const isToday = ds === todayStr
              const dayApps = day ? appsForDay(day) : []
              return (
                <div
                  key={idx}
                  onClick={() => day && (setSelectedDay(ds), setSelectedDay(prev => prev === ds ? null : ds))}
                  className={`min-h-[72px] sm:min-h-[90px] border-b border-r border-gray-100 p-1 cursor-pointer transition-colors last:border-r-0 ${day ? 'hover:bg-orange-50/50' : 'bg-gray-50/50'} ${selectedDay === ds ? 'bg-orange-50' : ''}`}
                >
                  {day && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full ${isToday ? 'bg-orange-500 text-white' : 'text-gray-700'}`}>
                          {day}
                        </span>
                        <button
                          onClick={e => { e.stopPropagation(); openNew(ds) }}
                          className="opacity-0 group-hover:opacity-100 hover:opacity-100 text-gray-300 hover:text-orange-500 p-0.5"
                        >
                          <Plus size={11} />
                        </button>
                      </div>
                      <div className="mt-0.5 space-y-0.5">
                        {dayApps.slice(0, 3).map(a => {
                          const meta = TYPE_META[a.type]
                          return (
                            <button
                              key={a.id}
                              onClick={e => { e.stopPropagation(); openDetail(a) }}
                              className={`w-full text-left text-xs px-1.5 py-0.5 rounded truncate ${meta.bg} ${meta.color} font-medium`}
                            >
                              <span className="hidden sm:inline">{a.startTime} </span>{a.title}
                            </button>
                          )
                        })}
                        {dayApps.length > 3 && (
                          <p className="text-xs text-gray-400 px-1">+{dayApps.length - 3} altri</p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Day detail panel when day selected */}
      {view === 'month' && selectedDay && (() => {
        const apps = appointments.filter(a => a.date === selectedDay).sort((a, b) => a.startTime.localeCompare(b.startTime))
        const [y, m, d] = selectedDay.split('-')
        return (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-800">
                {parseInt(d)} {MONTHS_IT[parseInt(m) - 1]} {y}
              </h3>
              <button onClick={() => openNew(selectedDay)} className="flex items-center gap-1 text-sm text-orange-500 hover:text-orange-600">
                <Plus size={14} /> Aggiungi
              </button>
            </div>
            {apps.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">Nessun appuntamento</p>
            ) : (
              <div className="space-y-2">
                {apps.map(a => <AppCard key={a.id} app={a} state={state} onEdit={openEdit} onDelete={del} onOpen={openDetail} />)}
              </div>
            )}
          </div>
        )
      })()}

      {/* List view */}
      {view === 'list' && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-600">Prossimi appuntamenti</h3>
          {upcomingApps.length === 0 ? (
            <div className="bg-white rounded-xl p-8 text-center text-gray-400 border border-gray-100">
              <p>Nessun appuntamento in programma</p>
              <button onClick={() => openNew()} className="mt-3 text-orange-500 text-sm hover:text-orange-600">+ Aggiungi appuntamento</button>
            </div>
          ) : (
            upcomingApps.map(a => <AppCard key={a.id} app={a} state={state} onEdit={openEdit} onDelete={del} onOpen={openDetail} showDate />)
          )}
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-3">
        {Object.entries(TYPE_META).map(([type, meta]) => (
          <div key={type} className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className={`w-2.5 h-2.5 rounded-full ${meta.dot}`} />
            {meta.label}
          </div>
        ))}
      </div>

      {/* Form Modal */}
      {modal === 'form' && (
        <Modal title={editing ? 'Modifica Appuntamento' : 'Nuovo Appuntamento'} onClose={() => setModal(null)} size="lg">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Input label="Titolo" required value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Es. Sopralluogo Villa Rossi" />
            </div>
            <Select label="Tipo" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as AppointmentType }))}
              options={Object.entries(TYPE_META).map(([v, m]) => ({ value: v, label: m.label }))} />
            <Input label="Data" type="date" required value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            <Input label="Ora inizio" type="time" value={form.startTime} onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))} />
            <Input label="Ora fine" type="time" value={form.endTime} onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))} />
            <Select label="Progetto" value={form.projectId || ''} onChange={e => setForm(f => ({ ...f, projectId: e.target.value }))}
              options={[{ value: '', label: '-- Nessuno --' }, ...state.projects.map(p => ({ value: p.id, label: p.name }))]} />
            <Select label="Cliente" value={form.clientId || ''} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}
              options={[{ value: '', label: '-- Nessuno --' }, ...state.clients.map(c => ({ value: c.id, label: c.name }))]} />
            <div className="sm:col-span-2">
              <Input label="Luogo / Indirizzo" value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="Via Roma 10, Milano" />
            </div>
            <div className="sm:col-span-2">
              <Textarea label="Note" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} />
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="reminder" checked={form.reminder} onChange={e => setForm(f => ({ ...f, reminder: e.target.checked }))} className="w-4 h-4 accent-orange-500" />
              <label htmlFor="reminder" className="text-sm text-gray-700 flex items-center gap-1.5"><Bell size={14} className="text-orange-500" />Imposta promemoria</label>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-5 pt-4 border-t border-gray-100">
            <button onClick={() => setModal(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Annulla</button>
            <button onClick={save} className="px-5 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600">Salva</button>
          </div>
        </Modal>
      )}

      {/* Detail Modal */}
      {modal === 'detail' && selected && (
        <Modal title={selected.title} onClose={() => setModal(null)} size="md">
          <div className="space-y-4">
            <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${TYPE_META[selected.type].bg} ${TYPE_META[selected.type].color}`}>
              <span className={`w-2 h-2 rounded-full ${TYPE_META[selected.type].dot}`} />
              {TYPE_META[selected.type].label}
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-gray-400 text-xs">Data</p>
                <p className="font-medium text-gray-700">{(() => { const [y,m,d] = selected.date.split('-'); return `${parseInt(d)} ${MONTHS_IT[parseInt(m)-1]} ${y}` })()}</p>
              </div>
              <div>
                <p className="text-gray-400 text-xs">Orario</p>
                <p className="font-medium text-gray-700 flex items-center gap-1"><Clock size={13} />{selected.startTime} – {selected.endTime}</p>
              </div>
            </div>
            {selected.location && (
              <div className="flex items-start gap-2 text-sm bg-gray-50 rounded-lg p-3">
                <MapPin size={15} className="text-gray-400 mt-0.5 flex-shrink-0" />
                <p className="text-gray-700">{selected.location}</p>
              </div>
            )}
            {selected.projectId && <div className="text-sm"><span className="text-gray-400">Progetto: </span><span className="font-medium">{state.projects.find(p => p.id === selected.projectId)?.name}</span></div>}
            {selected.clientId && <div className="text-sm"><span className="text-gray-400">Cliente: </span><span className="font-medium">{state.clients.find(c => c.id === selected.clientId)?.name}</span></div>}
            {selected.notes && <p className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3 italic">{selected.notes}</p>}
            {selected.reminder && <div className="flex items-center gap-1.5 text-xs text-orange-600"><Bell size={13} />Promemoria attivo</div>}
          </div>
          <div className="flex justify-between mt-5 pt-4 border-t border-gray-100">
            <button onClick={() => del(selected.id)} className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-600 px-3 py-2 hover:bg-red-50 rounded-lg">
              <Trash2 size={14} /> Elimina
            </button>
            <button onClick={() => { openEdit(selected) }} className="flex items-center gap-1.5 text-sm bg-orange-500 text-white px-4 py-2 rounded-lg hover:bg-orange-600">
              <Edit2 size={14} /> Modifica
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function AppCard({ app, state, onEdit, onDelete, onOpen, showDate }: {
  app: Appointment; state: any
  onEdit: (a: Appointment) => void
  onDelete: (id: string) => void
  onOpen: (a: Appointment) => void
  showDate?: boolean
}) {
  const meta = TYPE_META[app.type]
  const project = state.projects.find((p: any) => p.id === app.projectId)
  const client = state.clients.find((c: any) => c.id === app.clientId)
  const [, m, d] = app.date.split('-')
  const MONTHS_IT = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic']

  return (
    <div className={`bg-white rounded-xl border-l-4 shadow-sm p-4 flex gap-3 items-start`} style={{ borderLeftColor: meta.dot.replace('bg-', '').includes('blue') ? '#3b82f6' : meta.dot.replace('bg-', '').includes('purple') ? '#8b5cf6' : meta.dot.replace('bg-', '').includes('green') ? '#22c55e' : meta.dot.replace('bg-', '').includes('orange') ? '#f97316' : meta.dot.replace('bg-', '').includes('red') ? '#ef4444' : '#9ca3af' }}>
      {showDate && (
        <div className="text-center bg-gray-50 rounded-lg px-2 py-1.5 flex-shrink-0 min-w-[44px]">
          <p className="text-xs text-gray-400 leading-none">{MONTHS_IT[parseInt(m)-1]}</p>
          <p className="text-lg font-bold text-gray-700 leading-tight">{parseInt(d)}</p>
        </div>
      )}
      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onOpen(app)}>
        <div className="flex items-start justify-between gap-2">
          <p className="font-semibold text-sm text-gray-800 truncate">{app.title}</p>
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${meta.bg} ${meta.color}`}>{meta.label}</span>
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
          <span className="flex items-center gap-1"><Clock size={11} />{app.startTime}–{app.endTime}</span>
          {app.location && <span className="flex items-center gap-1 truncate"><MapPin size={11} />{app.location}</span>}
        </div>
        {(project || client) && (
          <p className="text-xs text-gray-400 mt-1 truncate">{[project?.name, client?.name].filter(Boolean).join(' • ')}</p>
        )}
      </div>
      <div className="flex gap-1 flex-shrink-0">
        <button onClick={() => onEdit(app)} className="p-1.5 text-gray-400 hover:text-orange-500 hover:bg-orange-50 rounded-lg"><Edit2 size={13} /></button>
        <button onClick={() => onDelete(app.id)} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={13} /></button>
      </div>
    </div>
  )
}
