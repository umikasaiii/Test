export type AppointmentType = 'sopralluogo' | 'riunione' | 'collaudo' | 'consegna' | 'scadenza' | 'altro'

export interface Appointment {
  id: string
  title: string
  type: AppointmentType
  date: string        // YYYY-MM-DD
  startTime: string   // HH:MM
  endTime: string     // HH:MM
  projectId?: string
  clientId?: string
  location: string
  notes: string
  reminder: boolean
  createdAt: string
}
