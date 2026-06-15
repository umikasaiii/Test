import { useState, useRef, useEffect } from 'react'
import { useApp } from '../context/AppContext'
import Modal from '../components/ui/Modal'
import { Input, Select, Textarea } from '../components/ui/FormField'
import {
  Plus, Edit2, Trash2, Camera, Image, Printer, FileImage,
  Ruler, Euro, ListChecks, X, Upload, ChevronDown, ChevronUp
} from 'lucide-react'

const STORAGE_KEY = 'edile_renders_v1'

interface Measurement { id: string; label: string; value: string; unit: string }
interface WorkItem { id: string; description: string; quantity: number; unit: string; unitPrice: number }
interface WorkRender {
  id: string
  projectId: string
  title: string
  subtitle: string
  description: string
  beforePhotos: string[]   // base64
  afterPhotos: string[]    // base64
  measurements: Measurement[]
  works: WorkItem[]
  quoteTotal: number
  clientNotes: string
  completionDate: string
  technician: string
  companyName: string
  createdAt: string
}

function loadRenders(): WorkRender[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}
function saveRenders(r: WorkRender[]) { localStorage.setItem(STORAGE_KEY, JSON.stringify(r)) }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7) }

const emptyMeasure = (): Measurement => ({ id: genId(), label: '', value: '', unit: 'm²' })
const emptyWork = (): WorkItem => ({ id: genId(), description: '', quantity: 1, unit: 'pz', unitPrice: 0 })

const emptyForm = (): Omit<WorkRender, 'id' | 'createdAt'> => ({
  projectId: '', title: '', subtitle: '', description: '',
  beforePhotos: [], afterPhotos: [], measurements: [emptyMeasure()],
  works: [emptyWork()], quoteTotal: 0, clientNotes: '',
  completionDate: new Date().toISOString().slice(0, 10),
  technician: '', companyName: 'EdilGestionale Srl',
})

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function Rendering() {
  const { state } = useApp()
  const [renders, setRenders] = useState<WorkRender[]>(loadRenders)
  const [modal, setModal] = useState<'form' | 'report' | null>(null)
  const [editing, setEditing] = useState<WorkRender | null>(null)
  const [form, setForm] = useState<Omit<WorkRender, 'id' | 'createdAt'>>(emptyForm())
  const [reportData, setReportData] = useState<WorkRender | null>(null)
  const beforeRef = useRef<HTMLInputElement>(null)
  const afterRef = useRef<HTMLInputElement>(null)

  useEffect(() => { saveRenders(renders) }, [renders])

  const fmt = (n: number) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' })

  const calcTotal = (works: WorkItem[]) => works.reduce((s, w) => s + w.quantity * w.unitPrice, 0)

  async function handlePhotoUpload(files: FileList | null, type: 'before' | 'after') {
    if (!files) return
    const b64s = await Promise.all(Array.from(files).map(fileToBase64))
    setForm(f => ({
      ...f,
      beforePhotos: type === 'before' ? [...f.beforePhotos, ...b64s] : f.beforePhotos,
      afterPhotos: type === 'after' ? [...f.afterPhotos, ...b64s] : f.afterPhotos,
    }))
  }

  function openNew() { setEditing(null); setForm(emptyForm()); setModal('form') }
  function openEdit(r: WorkRender) {
    setEditing(r)
    setForm({ projectId: r.projectId, title: r.title, subtitle: r.subtitle, description: r.description, beforePhotos: r.beforePhotos, afterPhotos: r.afterPhotos, measurements: r.measurements, works: r.works, quoteTotal: r.quoteTotal, clientNotes: r.clientNotes, completionDate: r.completionDate, technician: r.technician, companyName: r.companyName })
    setModal('form')
  }

  function save() {
    const now = new Date().toISOString()
    const total = calcTotal(form.works)
    const payload = { ...form, quoteTotal: total }
    if (editing) setRenders(prev => prev.map(r => r.id === editing.id ? { ...editing, ...payload } : r))
    else setRenders(prev => [...prev, { id: genId(), ...payload, createdAt: now }])
    setModal(null)
  }

  function del(id: string) { if (confirm('Eliminare questo rendering?')) setRenders(prev => prev.filter(r => r.id !== id)) }

  function openReport(r: WorkRender) { setReportData(r); setModal('report') }

  function updateWork(idx: number, field: keyof WorkItem, val: string | number) {
    setForm(f => ({ ...f, works: f.works.map((w, i) => i === idx ? { ...w, [field]: val } : w) }))
  }
  function updateMeasure(idx: number, field: keyof Measurement, val: string) {
    setForm(f => ({ ...f, measurements: f.measurements.map((m, i) => i === idx ? { ...m, [field]: val } : m) }))
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">Crea schede comparativa Prima & Dopo con report professionale stampabile.</p>
        <button onClick={openNew} className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
          <Plus size={16} /> Nuova Scheda
        </button>
      </div>

      {renders.length === 0 && (
        <div className="bg-white rounded-xl border border-dashed border-gray-300 p-16 text-center">
          <FileImage size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 font-medium">Nessuna scheda prima & dopo</p>
          <p className="text-sm text-gray-400 mt-1">Crea una scheda per ogni lavoro completato con foto e dettagli</p>
          <button onClick={openNew} className="mt-4 bg-orange-500 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">Crea la prima scheda</button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {renders.map(r => {
          const project = state.projects.find(p => p.id === r.projectId)
          return (
            <div key={r.id} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              {/* Photo preview */}
              <div className="grid grid-cols-2 h-40">
                <div className="relative bg-gray-100 overflow-hidden">
                  {r.beforePhotos[0]
                    ? <img src={r.beforePhotos[0]} alt="Prima" className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex flex-col items-center justify-center text-gray-300"><Camera size={28} /><p className="text-xs mt-1">Prima</p></div>}
                  <span className="absolute top-2 left-2 bg-black/60 text-white text-xs px-2 py-0.5 rounded-full">PRIMA</span>
                </div>
                <div className="relative bg-gray-100 overflow-hidden border-l-2 border-white">
                  {r.afterPhotos[0]
                    ? <img src={r.afterPhotos[0]} alt="Dopo" className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex flex-col items-center justify-center text-gray-300"><Image size={28} /><p className="text-xs mt-1">Dopo</p></div>}
                  <span className="absolute top-2 left-2 bg-orange-500 text-white text-xs px-2 py-0.5 rounded-full">DOPO</span>
                </div>
              </div>
              <div className="p-4">
                <h3 className="font-bold text-gray-800">{r.title}</h3>
                {r.subtitle && <p className="text-xs text-gray-500 mt-0.5">{r.subtitle}</p>}
                {project && <p className="text-xs text-blue-600 mt-1">{project.name}</p>}
                <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                  <span className="flex items-center gap-1"><Ruler size={11} />{r.measurements.length} misure</span>
                  <span className="flex items-center gap-1"><ListChecks size={11} />{r.works.length} lavori</span>
                  <span className="flex items-center gap-1 font-semibold text-green-600"><Euro size={11} />{fmt(r.quoteTotal)}</span>
                </div>
                <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100">
                  <button onClick={() => openReport(r)} className="flex-1 flex items-center justify-center gap-1 text-xs bg-gray-800 text-white py-2 rounded-lg hover:bg-gray-700">
                    <Printer size={12} /> Report PDF
                  </button>
                  <button onClick={() => openEdit(r)} className="flex-1 flex items-center justify-center gap-1 text-xs text-gray-600 hover:text-orange-600 py-2 hover:bg-orange-50 rounded-lg border border-gray-200">
                    <Edit2 size={12} /> Modifica
                  </button>
                  <button onClick={() => del(r.id)} className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg border border-gray-200"><Trash2 size={13} /></button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Form Modal */}
      {modal === 'form' && (
        <Modal title={editing ? 'Modifica Scheda' : 'Nuova Scheda Prima & Dopo'} onClose={() => setModal(null)} size="xl">
          <div className="space-y-6">
            {/* Info base */}
            <Section title="Informazioni Generali">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2"><Input label="Titolo lavoro" required value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Es. Ristrutturazione bagno principale" /></div>
                <Input label="Sottotitolo" value={form.subtitle} onChange={e => setForm(f => ({ ...f, subtitle: e.target.value }))} placeholder="Es. Via Roma 10, Milano" />
                <Select label="Progetto" value={form.projectId} onChange={e => setForm(f => ({ ...f, projectId: e.target.value }))}
                  options={[{ value: '', label: '-- Nessuno --' }, ...state.projects.map(p => ({ value: p.id, label: p.name }))]} />
                <Input label="Tecnico responsabile" value={form.technician} onChange={e => setForm(f => ({ ...f, technician: e.target.value }))} />
                <Input label="Data completamento" type="date" value={form.completionDate} onChange={e => setForm(f => ({ ...f, completionDate: e.target.value }))} />
                <div className="sm:col-span-2"><Textarea label="Descrizione lavori" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} /></div>
              </div>
            </Section>

            {/* Photos */}
            <Section title="Foto Prima & Dopo">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {(['before', 'after'] as const).map(type => (
                  <div key={type}>
                    <p className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                      {type === 'before' ? <><Camera size={15} className="text-gray-500" /> Foto PRIMA</> : <><Image size={15} className="text-orange-500" /> Foto DOPO</>}
                    </p>
                    <div
                      onClick={() => type === 'before' ? beforeRef.current?.click() : afterRef.current?.click()}
                      className="border-2 border-dashed border-gray-200 rounded-xl p-4 cursor-pointer hover:border-orange-400 hover:bg-orange-50/30 transition-colors"
                    >
                      {(type === 'before' ? form.beforePhotos : form.afterPhotos).length === 0 ? (
                        <div className="text-center py-4">
                          <Upload size={24} className="mx-auto text-gray-300 mb-2" />
                          <p className="text-xs text-gray-400">Clicca o trascina le foto qui</p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-3 gap-1.5">
                          {(type === 'before' ? form.beforePhotos : form.afterPhotos).map((src, i) => (
                            <div key={i} className="relative group aspect-square rounded-lg overflow-hidden">
                              <img src={src} alt="" className="w-full h-full object-cover" />
                              <button
                                onClick={e => { e.stopPropagation(); setForm(f => ({ ...f, [type === 'before' ? 'beforePhotos' : 'afterPhotos']: (type === 'before' ? f.beforePhotos : f.afterPhotos).filter((_, j) => j !== i) })) }}
                                className="absolute top-0.5 right-0.5 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                              ><X size={10} /></button>
                            </div>
                          ))}
                          <div className="aspect-square rounded-lg border-2 border-dashed border-gray-200 flex items-center justify-center cursor-pointer hover:border-orange-400">
                            <Plus size={18} className="text-gray-300" />
                          </div>
                        </div>
                      )}
                    </div>
                    <input ref={type === 'before' ? beforeRef : afterRef} type="file" accept="image/*" multiple className="hidden" onChange={e => handlePhotoUpload(e.target.files, type)} />
                  </div>
                ))}
              </div>
            </Section>

            {/* Measurements */}
            <Section title="Misure & Superfici">
              <div className="space-y-2">
                {form.measurements.map((m, idx) => (
                  <div key={m.id} className="grid grid-cols-12 gap-2 items-center">
                    <input value={m.label} onChange={e => updateMeasure(idx, 'label', e.target.value)} placeholder="Es. Superficie pavimento" className="col-span-5 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" />
                    <input value={m.value} onChange={e => updateMeasure(idx, 'value', e.target.value)} placeholder="45" className="col-span-3 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 text-right" />
                    <select value={m.unit} onChange={e => updateMeasure(idx, 'unit', e.target.value)} className="col-span-3 border border-gray-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400">
                      {['m²', 'm³', 'm', 'cm', 'mm', 'pz', 'kg', 'lt'].map(u => <option key={u}>{u}</option>)}
                    </select>
                    <button onClick={() => setForm(f => ({ ...f, measurements: f.measurements.filter((_, i) => i !== idx) }))} className="col-span-1 p-2 text-gray-300 hover:text-red-400"><X size={14} /></button>
                  </div>
                ))}
                <button onClick={() => setForm(f => ({ ...f, measurements: [...f.measurements, emptyMeasure()] }))} className="flex items-center gap-1.5 text-sm text-orange-500 hover:text-orange-600 font-medium">
                  <Plus size={14} /> Aggiungi misura
                </button>
              </div>
            </Section>

            {/* Works list */}
            <Section title="Lista Lavori & Preventivo">
              <div className="space-y-2">
                <div className="grid grid-cols-12 gap-2 text-xs text-gray-400 font-medium px-1">
                  <span className="col-span-5">Descrizione lavoro</span>
                  <span className="col-span-2 text-right">Qtà</span>
                  <span className="col-span-2">UM</span>
                  <span className="col-span-2 text-right">Prezzo €</span>
                  <span className="col-span-1" />
                </div>
                {form.works.map((w, idx) => (
                  <div key={w.id} className="grid grid-cols-12 gap-2 items-center">
                    <input value={w.description} onChange={e => updateWork(idx, 'description', e.target.value)} placeholder="Es. Demolizione pavimento" className="col-span-5 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" />
                    <input type="number" value={w.quantity} onChange={e => updateWork(idx, 'quantity', +e.target.value)} className="col-span-2 border border-gray-200 rounded-lg px-2 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-orange-400" />
                    <select value={w.unit} onChange={e => updateWork(idx, 'unit', e.target.value)} className="col-span-2 border border-gray-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400">
                      {['pz', 'm²', 'm³', 'm', 'h', 'cad', 'kg', 'lt', 'corpo'].map(u => <option key={u}>{u}</option>)}
                    </select>
                    <input type="number" value={w.unitPrice} onChange={e => updateWork(idx, 'unitPrice', +e.target.value)} className="col-span-2 border border-gray-200 rounded-lg px-2 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-orange-400" />
                    <button onClick={() => setForm(f => ({ ...f, works: f.works.filter((_, i) => i !== idx) }))} className="col-span-1 p-2 text-gray-300 hover:text-red-400"><X size={14} /></button>
                  </div>
                ))}
                <button onClick={() => setForm(f => ({ ...f, works: [...f.works, emptyWork()] }))} className="flex items-center gap-1.5 text-sm text-orange-500 hover:text-orange-600 font-medium">
                  <Plus size={14} /> Aggiungi voce
                </button>
                <div className="flex justify-end mt-2 pt-3 border-t border-gray-100">
                  <div className="bg-gray-50 rounded-xl p-3 text-right min-w-48">
                    <p className="text-xs text-gray-400">Totale preventivo</p>
                    <p className="text-xl font-bold text-gray-800">{fmt(calcTotal(form.works))}</p>
                  </div>
                </div>
              </div>
            </Section>

            {/* Client notes */}
            <Section title="Note per il Cliente">
              <Textarea label="" value={form.clientNotes} onChange={e => setForm(f => ({ ...f, clientNotes: e.target.value }))} rows={3} placeholder="Garanzie, raccomandazioni post-lavoro, istruzioni di manutenzione..." />
            </Section>
          </div>

          <div className="flex justify-end gap-3 mt-5 pt-4 border-t border-gray-100 sticky bottom-0 bg-white">
            <button onClick={() => setModal(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Annulla</button>
            <button onClick={save} className="px-5 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600">Salva Scheda</button>
          </div>
        </Modal>
      )}

      {/* Report Modal */}
      {modal === 'report' && reportData && (
        <Modal title="Report Prima & Dopo" onClose={() => setModal(null)} size="xl">
          <div className="mb-4 flex justify-end">
            <button
              onClick={() => window.print()}
              className="flex items-center gap-2 bg-gray-800 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-gray-700"
            >
              <Printer size={15} /> Stampa / Salva PDF
            </button>
          </div>
          <ReportView render={reportData} state={state} fmt={fmt} />
        </Modal>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 text-sm font-semibold text-gray-700 hover:bg-gray-100 transition-colors">
        {title}
        {open ? <ChevronUp size={15} className="text-gray-400" /> : <ChevronDown size={15} className="text-gray-400" />}
      </button>
      {open && <div className="p-4">{children}</div>}
    </div>
  )
}

function ReportView({ render: r, state, fmt }: { render: WorkRender; state: any; fmt: (n: number) => string }) {
  const project = state.projects.find((p: any) => p.id === r.projectId)
  const client = project ? state.clients.find((c: any) => c.id === project.clientId) : null
  const date = new Date(r.completionDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="print-report bg-white" id="report-content">
      {/* ─── HEADER ─── */}
      <div className="bg-gradient-to-r from-gray-900 to-gray-800 text-white p-8 rounded-xl mb-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="bg-orange-500 rounded-xl w-12 h-12 flex items-center justify-center font-black text-xl">E</div>
              <div>
                <p className="font-bold text-lg leading-tight">{r.companyName}</p>
                <p className="text-gray-400 text-sm">Impresa Edile</p>
              </div>
            </div>
            <h1 className="text-3xl font-black tracking-tight text-white">{r.title}</h1>
            {r.subtitle && <p className="text-gray-300 mt-1 text-base">{r.subtitle}</p>}
          </div>
          <div className="text-right flex-shrink-0">
            <div className="bg-orange-500 text-white px-4 py-2 rounded-xl font-bold text-sm mb-2">REPORT LAVORI</div>
            <p className="text-gray-300 text-sm">Completato il</p>
            <p className="font-semibold text-white">{date}</p>
            {r.technician && <p className="text-gray-400 text-xs mt-1">Tecnico: {r.technician}</p>}
          </div>
        </div>
      </div>

      {/* ─── CLIENT + PROJECT INFO ─── */}
      {(client || project) && (
        <div className="grid grid-cols-2 gap-4 mb-6">
          {client && (
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-2">Cliente</p>
              <p className="font-bold text-gray-800">{client.name}</p>
              {client.address && <p className="text-sm text-gray-500">{client.address}, {client.city}</p>}
              {client.phone && <p className="text-sm text-gray-500">{client.phone}</p>}
            </div>
          )}
          {project && (
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-2">Progetto</p>
              <p className="font-bold text-gray-800">{project.name}</p>
              <p className="text-sm text-gray-500">{project.address}, {project.city}</p>
              <p className="text-sm text-gray-500">Codice: {project.code}</p>
            </div>
          )}
        </div>
      )}

      {/* ─── DESCRIPTION ─── */}
      {r.description && (
        <div className="mb-6 bg-blue-50 border border-blue-100 rounded-xl p-4">
          <p className="text-xs text-blue-600 uppercase font-semibold tracking-wide mb-1">Descrizione Intervento</p>
          <p className="text-gray-700 text-sm leading-relaxed">{r.description}</p>
        </div>
      )}

      {/* ─── BEFORE / AFTER PHOTOS ─── */}
      {(r.beforePhotos.length > 0 || r.afterPhotos.length > 0) && (
        <div className="mb-8">
          <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
            <span className="w-1 h-5 bg-orange-500 rounded-full" />
            Documentazione Fotografica
          </h2>

          <div className="grid grid-cols-2 gap-3">
            {/* BEFORE column */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="bg-gray-800 text-white text-xs font-bold px-3 py-1 rounded-full">PRIMA</span>
                <span className="text-xs text-gray-400">{r.beforePhotos.length} foto</span>
              </div>
              <div className={`grid gap-2 ${r.beforePhotos.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {r.beforePhotos.map((src, i) => (
                  <div key={i} className="rounded-xl overflow-hidden border-2 border-gray-200 aspect-video bg-gray-100">
                    <img src={src} alt={`Prima ${i + 1}`} className="w-full h-full object-cover" />
                  </div>
                ))}
              </div>
            </div>

            {/* AFTER column */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="bg-orange-500 text-white text-xs font-bold px-3 py-1 rounded-full">DOPO</span>
                <span className="text-xs text-gray-400">{r.afterPhotos.length} foto</span>
              </div>
              <div className={`grid gap-2 ${r.afterPhotos.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {r.afterPhotos.map((src, i) => (
                  <div key={i} className="rounded-xl overflow-hidden border-2 border-orange-200 aspect-video bg-gray-100">
                    <img src={src} alt={`Dopo ${i + 1}`} className="w-full h-full object-cover" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-8">
        {/* ─── MEASUREMENTS ─── */}
        {r.measurements.length > 0 && (
          <div>
            <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
              <span className="w-1 h-5 bg-blue-500 rounded-full" />
              Misure & Superfici
            </h2>
            <div className="bg-white border border-gray-100 rounded-xl overflow-hidden shadow-sm">
              <table className="w-full text-sm">
                <thead className="bg-gray-800 text-white">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-semibold">Elemento</th>
                    <th className="text-right px-4 py-2.5 font-semibold">Misura</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {r.measurements.map((m, i) => (
                    <tr key={m.id} className={i % 2 === 0 ? '' : 'bg-gray-50'}>
                      <td className="px-4 py-2.5 text-gray-700">{m.label || '—'}</td>
                      <td className="px-4 py-2.5 text-right font-bold text-gray-800">{m.value} {m.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ─── WORKS + QUOTE ─── */}
        {r.works.length > 0 && (
          <div>
            <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
              <span className="w-1 h-5 bg-green-500 rounded-full" />
              Lista Lavori Eseguiti
            </h2>
            <div className="bg-white border border-gray-100 rounded-xl overflow-hidden shadow-sm">
              <table className="w-full text-sm">
                <thead className="bg-gray-800 text-white">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-semibold">Lavoro</th>
                    <th className="text-right px-4 py-2.5 font-semibold">Qtà</th>
                    <th className="text-right px-4 py-2.5 font-semibold">Importo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {r.works.map((w, i) => (
                    <tr key={w.id} className={i % 2 === 0 ? '' : 'bg-gray-50'}>
                      <td className="px-4 py-2.5 text-gray-700">{w.description || '—'}</td>
                      <td className="px-4 py-2.5 text-right text-gray-500">{w.quantity} {w.unit}</td>
                      <td className="px-4 py-2.5 text-right font-medium text-gray-800">{fmt(w.quantity * w.unitPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Total box */}
              <div className="bg-gradient-to-r from-orange-500 to-orange-600 p-4 flex items-center justify-between">
                <div>
                  <p className="text-orange-100 text-xs font-medium uppercase tracking-wide">Totale Preventivo</p>
                  <p className="text-white text-xs opacity-80 mt-0.5">IVA esclusa salvo diversa indicazione</p>
                </div>
                <p className="text-white text-2xl font-black">{fmt(r.quoteTotal)}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ─── CLIENT NOTES ─── */}
      {r.clientNotes && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl p-5">
          <p className="text-xs text-amber-700 uppercase font-semibold tracking-wide mb-2">Note e Raccomandazioni</p>
          <p className="text-gray-700 text-sm leading-relaxed">{r.clientNotes}</p>
        </div>
      )}

      {/* ─── FOOTER ─── */}
      <div className="border-t-2 border-gray-100 pt-6 mt-6">
        <div className="flex items-center justify-between text-xs text-gray-400">
          <div>
            <p className="font-semibold text-gray-600">{r.companyName}</p>
            <p>Documento generato automaticamente da EdilGestionale</p>
          </div>
          <div className="text-right">
            <p>Data stampa: {new Date().toLocaleDateString('it-IT')}</p>
            {r.technician && <p>Tecnico: {r.technician}</p>}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-8">
          <div className="text-center">
            <div className="h-10 border-b-2 border-gray-300 mb-1" />
            <p className="text-xs text-gray-400">Firma Tecnico</p>
          </div>
          <div className="text-center">
            <div className="h-10 border-b-2 border-gray-300 mb-1" />
            <p className="text-xs text-gray-400">Firma Cliente</p>
          </div>
        </div>
      </div>
    </div>
  )
}
