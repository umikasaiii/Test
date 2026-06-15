import React, { createContext, useContext, useReducer, useEffect } from 'react'
import type { AppState, Project, Task, Worker, Attendance, Client, Supplier, Material, MaterialOrder, Invoice, Expense, Document } from '../types'
import { loadState, saveState } from '../utils/storage'

type Action =
  | { type: 'SET_STATE'; payload: AppState }
  | { type: 'ADD_PROJECT'; payload: Project }
  | { type: 'UPDATE_PROJECT'; payload: Project }
  | { type: 'DELETE_PROJECT'; payload: string }
  | { type: 'ADD_TASK'; payload: Task }
  | { type: 'UPDATE_TASK'; payload: Task }
  | { type: 'DELETE_TASK'; payload: string }
  | { type: 'ADD_WORKER'; payload: Worker }
  | { type: 'UPDATE_WORKER'; payload: Worker }
  | { type: 'DELETE_WORKER'; payload: string }
  | { type: 'ADD_ATTENDANCE'; payload: Attendance }
  | { type: 'UPDATE_ATTENDANCE'; payload: Attendance }
  | { type: 'DELETE_ATTENDANCE'; payload: string }
  | { type: 'ADD_CLIENT'; payload: Client }
  | { type: 'UPDATE_CLIENT'; payload: Client }
  | { type: 'DELETE_CLIENT'; payload: string }
  | { type: 'ADD_SUPPLIER'; payload: Supplier }
  | { type: 'UPDATE_SUPPLIER'; payload: Supplier }
  | { type: 'DELETE_SUPPLIER'; payload: string }
  | { type: 'ADD_MATERIAL'; payload: Material }
  | { type: 'UPDATE_MATERIAL'; payload: Material }
  | { type: 'DELETE_MATERIAL'; payload: string }
  | { type: 'ADD_MATERIAL_ORDER'; payload: MaterialOrder }
  | { type: 'UPDATE_MATERIAL_ORDER'; payload: MaterialOrder }
  | { type: 'DELETE_MATERIAL_ORDER'; payload: string }
  | { type: 'ADD_INVOICE'; payload: Invoice }
  | { type: 'UPDATE_INVOICE'; payload: Invoice }
  | { type: 'DELETE_INVOICE'; payload: string }
  | { type: 'ADD_EXPENSE'; payload: Expense }
  | { type: 'UPDATE_EXPENSE'; payload: Expense }
  | { type: 'DELETE_EXPENSE'; payload: string }
  | { type: 'ADD_DOCUMENT'; payload: Document }
  | { type: 'UPDATE_DOCUMENT'; payload: Document }
  | { type: 'DELETE_DOCUMENT'; payload: string }

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_STATE': return action.payload
    case 'ADD_PROJECT': return { ...state, projects: [...state.projects, action.payload] }
    case 'UPDATE_PROJECT': return { ...state, projects: state.projects.map(p => p.id === action.payload.id ? action.payload : p) }
    case 'DELETE_PROJECT': return { ...state, projects: state.projects.filter(p => p.id !== action.payload) }
    case 'ADD_TASK': return { ...state, tasks: [...state.tasks, action.payload] }
    case 'UPDATE_TASK': return { ...state, tasks: state.tasks.map(t => t.id === action.payload.id ? action.payload : t) }
    case 'DELETE_TASK': return { ...state, tasks: state.tasks.filter(t => t.id !== action.payload) }
    case 'ADD_WORKER': return { ...state, workers: [...state.workers, action.payload] }
    case 'UPDATE_WORKER': return { ...state, workers: state.workers.map(w => w.id === action.payload.id ? action.payload : w) }
    case 'DELETE_WORKER': return { ...state, workers: state.workers.filter(w => w.id !== action.payload) }
    case 'ADD_ATTENDANCE': return { ...state, attendances: [...state.attendances, action.payload] }
    case 'UPDATE_ATTENDANCE': return { ...state, attendances: state.attendances.map(a => a.id === action.payload.id ? action.payload : a) }
    case 'DELETE_ATTENDANCE': return { ...state, attendances: state.attendances.filter(a => a.id !== action.payload) }
    case 'ADD_CLIENT': return { ...state, clients: [...state.clients, action.payload] }
    case 'UPDATE_CLIENT': return { ...state, clients: state.clients.map(c => c.id === action.payload.id ? action.payload : c) }
    case 'DELETE_CLIENT': return { ...state, clients: state.clients.filter(c => c.id !== action.payload) }
    case 'ADD_SUPPLIER': return { ...state, suppliers: [...state.suppliers, action.payload] }
    case 'UPDATE_SUPPLIER': return { ...state, suppliers: state.suppliers.map(s => s.id === action.payload.id ? action.payload : s) }
    case 'DELETE_SUPPLIER': return { ...state, suppliers: state.suppliers.filter(s => s.id !== action.payload) }
    case 'ADD_MATERIAL': return { ...state, materials: [...state.materials, action.payload] }
    case 'UPDATE_MATERIAL': return { ...state, materials: state.materials.map(m => m.id === action.payload.id ? action.payload : m) }
    case 'DELETE_MATERIAL': return { ...state, materials: state.materials.filter(m => m.id !== action.payload) }
    case 'ADD_MATERIAL_ORDER': return { ...state, materialOrders: [...state.materialOrders, action.payload] }
    case 'UPDATE_MATERIAL_ORDER': return { ...state, materialOrders: state.materialOrders.map(o => o.id === action.payload.id ? action.payload : o) }
    case 'DELETE_MATERIAL_ORDER': return { ...state, materialOrders: state.materialOrders.filter(o => o.id !== action.payload) }
    case 'ADD_INVOICE': return { ...state, invoices: [...state.invoices, action.payload] }
    case 'UPDATE_INVOICE': return { ...state, invoices: state.invoices.map(i => i.id === action.payload.id ? action.payload : i) }
    case 'DELETE_INVOICE': return { ...state, invoices: state.invoices.filter(i => i.id !== action.payload) }
    case 'ADD_EXPENSE': return { ...state, expenses: [...state.expenses, action.payload] }
    case 'UPDATE_EXPENSE': return { ...state, expenses: state.expenses.map(e => e.id === action.payload.id ? action.payload : e) }
    case 'DELETE_EXPENSE': return { ...state, expenses: state.expenses.filter(e => e.id !== action.payload) }
    case 'ADD_DOCUMENT': return { ...state, documents: [...state.documents, action.payload] }
    case 'UPDATE_DOCUMENT': return { ...state, documents: state.documents.map(d => d.id === action.payload.id ? action.payload : d) }
    case 'DELETE_DOCUMENT': return { ...state, documents: state.documents.filter(d => d.id !== action.payload) }
    default: return state
  }
}

interface AppContextType {
  state: AppState
  dispatch: React.Dispatch<Action>
}

const AppContext = createContext<AppContextType | null>(null)

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadState)

  useEffect(() => {
    saveState(state)
  }, [state])

  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
