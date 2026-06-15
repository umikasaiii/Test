export type ProjectStatus = 'pianificato' | 'in_corso' | 'sospeso' | 'completato' | 'annullato'
export type ProjectPhase = 'progettazione' | 'permessi' | 'demolizioni' | 'fondazioni' | 'struttura' | 'impiantistica' | 'finiture' | 'collaudo'
export type WorkerRole = 'capocantiere' | 'muratore' | 'carpentiere' | 'elettricista' | 'idraulico' | 'imbianchino' | 'operaio' | 'geometra' | 'ingegnere' | 'altro'
export type InvoiceStatus = 'bozza' | 'inviata' | 'pagata' | 'scaduta' | 'annullata'
export type ExpenseCategory = 'materiali' | 'manodopera' | 'attrezzature' | 'noleggi' | 'trasporti' | 'subappalti' | 'utenze' | 'assicurazioni' | 'altro'
export type AttendanceStatus = 'presente' | 'assente' | 'ferie' | 'malattia' | 'permesso'

export interface Project {
  id: string
  name: string
  code: string
  clientId: string
  address: string
  city: string
  description: string
  status: ProjectStatus
  phase: ProjectPhase
  startDate: string
  endDate: string
  budget: number
  progress: number
  managerId: string
  workers: string[]
  notes: string
  createdAt: string
  updatedAt: string
}

export interface Task {
  id: string
  projectId: string
  title: string
  description: string
  assignedTo: string[]
  status: 'da_fare' | 'in_corso' | 'completata'
  priority: 'bassa' | 'media' | 'alta' | 'urgente'
  startDate: string
  dueDate: string
  completedAt?: string
  createdAt: string
}

export interface Worker {
  id: string
  firstName: string
  lastName: string
  role: WorkerRole
  phone: string
  email: string
  fiscalCode: string
  contractType: 'dipendente' | 'partita_iva' | 'subappaltatore'
  dailyRate: number
  hireDate: string
  active: boolean
  address: string
  city: string
  emergencyContact: string
  certifications: string[]
  notes: string
  createdAt: string
}

export interface Attendance {
  id: string
  workerId: string
  projectId: string
  date: string
  status: AttendanceStatus
  hoursWorked: number
  overtime: number
  notes: string
}

export interface Client {
  id: string
  type: 'privato' | 'azienda' | 'ente_pubblico'
  name: string
  contactPerson: string
  email: string
  phone: string
  address: string
  city: string
  zipCode: string
  fiscalCode: string
  vatNumber: string
  notes: string
  createdAt: string
}

export interface Supplier {
  id: string
  name: string
  category: string
  contactPerson: string
  email: string
  phone: string
  address: string
  city: string
  vatNumber: string
  paymentTerms: string
  rating: number
  notes: string
  createdAt: string
}

export interface Material {
  id: string
  name: string
  category: string
  unit: string
  unitPrice: number
  supplierId: string
  stock: number
  minStock: number
  code: string
  notes: string
  createdAt: string
}

export interface MaterialOrder {
  id: string
  materialId: string
  projectId: string
  supplierId: string
  quantity: number
  unitPrice: number
  totalPrice: number
  orderDate: string
  deliveryDate: string
  status: 'ordinato' | 'consegnato' | 'annullato'
  notes: string
  createdAt: string
}

export interface Invoice {
  id: string
  number: string
  clientId: string
  projectId: string
  issueDate: string
  dueDate: string
  status: InvoiceStatus
  items: InvoiceItem[]
  subtotal: number
  vatRate: number
  vatAmount: number
  total: number
  notes: string
  paidDate?: string
  createdAt: string
}

export interface InvoiceItem {
  id: string
  description: string
  quantity: number
  unitPrice: number
  total: number
}

export interface Expense {
  id: string
  projectId: string
  category: ExpenseCategory
  description: string
  amount: number
  date: string
  supplierId?: string
  receipt?: string
  approved: boolean
  approvedBy?: string
  notes: string
  createdAt: string
}

export interface Document {
  id: string
  projectId?: string
  name: string
  type: string
  category: 'contratto' | 'permesso' | 'progetto' | 'collaudo' | 'sicurezza' | 'altro'
  uploadDate: string
  expiryDate?: string
  notes: string
  createdAt: string
}

export interface AppState {
  projects: Project[]
  tasks: Task[]
  workers: Worker[]
  attendances: Attendance[]
  clients: Client[]
  suppliers: Supplier[]
  materials: Material[]
  materialOrders: MaterialOrder[]
  invoices: Invoice[]
  expenses: Expense[]
  documents: Document[]
}
