import type { AppState } from '../types'

export function generateSeedData(): AppState {
  const now = new Date().toISOString()

  const clients = [
    { id: 'c1', type: 'privato' as const, name: 'Mario Rossi', contactPerson: 'Mario Rossi', email: 'mario.rossi@email.it', phone: '3331234567', address: 'Via Roma 10', city: 'Milano', zipCode: '20100', fiscalCode: 'RSSMRA80A01F205X', vatNumber: '', notes: '', createdAt: now },
    { id: 'c2', type: 'azienda' as const, name: 'Costruzioni Bianchi Srl', contactPerson: 'Luigi Bianchi', email: 'info@bianchi.it', phone: '0223456789', address: 'Via Garibaldi 45', city: 'Torino', zipCode: '10100', fiscalCode: '', vatNumber: 'IT12345678901', notes: 'Cliente storico', createdAt: now },
    { id: 'c3', type: 'ente_pubblico' as const, name: 'Comune di Bergamo', contactPerson: 'Dott. Ferretti', email: 'lavori@comune.bergamo.it', phone: '0351234000', address: 'Piazza Matteotti 27', city: 'Bergamo', zipCode: '24100', fiscalCode: 'BRGCMN00000001', vatNumber: '', notes: 'Appalto pubblico', createdAt: now },
    { id: 'c4', type: 'privato' as const, name: 'Anna Verdi', contactPerson: 'Anna Verdi', email: 'a.verdi@gmail.com', phone: '3459876543', address: 'Corso Italia 22', city: 'Roma', zipCode: '00100', fiscalCode: 'VRDNNA85B41H501Y', vatNumber: '', notes: '', createdAt: now },
  ]

  const suppliers = [
    { id: 's1', name: 'Calcestruzzi Nord Srl', category: 'Calcestruzzo', contactPerson: 'Paolo Neri', email: 'ordini@calcestrunord.it', phone: '0226543210', address: 'Via Industriale 5', city: 'Sesto San Giovanni', vatNumber: 'IT09876543210', paymentTerms: '30 gg', rating: 5, notes: '', createdAt: now },
    { id: 's2', name: 'Ferro & Acciaio SpA', category: 'Ferro e acciaio', contactPerson: 'Sergio Conti', email: 's.conti@ferroeacciaio.it', phone: '0229876543', address: 'Via Metalli 12', city: 'Brescia', vatNumber: 'IT11223344556', paymentTerms: '60 gg', rating: 4, notes: 'Ottimi prezzi per grandi quantità', createdAt: now },
    { id: 's3', name: 'Edil Materiali Srl', category: 'Materiali edili', contactPerson: 'Franco Sala', email: 'info@edilmateriali.it', phone: '0234567890', address: 'Via Cantiere 8', city: 'Monza', vatNumber: 'IT55667788990', paymentTerms: '30 gg', rating: 4, notes: '', createdAt: now },
    { id: 's4', name: 'Elektro Impianti', category: 'Impianti elettrici', contactPerson: 'Marco Russo', email: 'm.russo@elektro.it', phone: '3476543210', address: 'Via Tesla 3', city: 'Milano', vatNumber: 'IT99887766554', paymentTerms: 'Rimessa diretta', rating: 5, notes: 'Certificati CEI', createdAt: now },
  ]

  const workers = [
    { id: 'w1', firstName: 'Giuseppe', lastName: 'Marino', role: 'capocantiere' as const, phone: '3331112233', email: 'g.marino@email.it', fiscalCode: 'MRNGPP70A01F205Z', contractType: 'dipendente' as const, dailyRate: 280, hireDate: '2018-03-01', active: true, address: 'Via Verdi 5', city: 'Milano', emergencyContact: 'Maria Marino 3331112244', certifications: ['PES', 'PAV', 'Primo Soccorso', 'Antincendio'], notes: 'Responsabile sicurezza', createdAt: now },
    { id: 'w2', firstName: 'Antonio', lastName: 'Ferrari', role: 'muratore' as const, phone: '3442223344', email: 'a.ferrari@email.it', fiscalCode: 'FRRNTN75C15F205A', contractType: 'dipendente' as const, dailyRate: 180, hireDate: '2019-06-15', active: true, address: 'Via Dante 12', city: 'Cinisello', emergencyContact: 'Rosa Ferrari 3442223355', certifications: ['Primo Soccorso'], notes: '', createdAt: now },
    { id: 'w3', firstName: 'Roberto', lastName: 'Esposito', role: 'carpentiere' as const, phone: '3553334455', email: 'r.esposito@email.it', fiscalCode: 'SPRRBT80H01F205B', contractType: 'dipendente' as const, dailyRate: 200, hireDate: '2020-01-10', active: true, address: 'Via Manzoni 8', city: 'Sesto', emergencyContact: 'Lucia Esposito 3553334466', certifications: ['Lavori in quota', 'Primo Soccorso'], notes: '', createdAt: now },
    { id: 'w4', firstName: 'Luca', lastName: 'Romano', role: 'elettricista' as const, phone: '3664445566', email: 'l.romano@email.it', fiscalCode: 'RMNLCU85D20F205C', contractType: 'partita_iva' as const, dailyRate: 250, hireDate: '2021-03-20', active: true, address: 'Via Carducci 15', city: 'Monza', emergencyContact: 'Sara Romano 3664445577', certifications: ['PES', 'PEI', 'CEI'], notes: 'Abilitato impianti civili e industriali', createdAt: now },
    { id: 'w5', firstName: 'Vincenzo', lastName: 'Greco', role: 'idraulico' as const, phone: '3775556677', email: 'v.greco@email.it', fiscalCode: 'GRCVCN78E01F205D', contractType: 'subappaltatore' as const, dailyRate: 230, hireDate: '2022-05-01', active: true, address: 'Via Leopardi 20', city: 'Paderno', emergencyContact: 'Carmela Greco 3775556688', certifications: ['Gas naturale', 'Primo Soccorso'], notes: '', createdAt: now },
    { id: 'w6', firstName: 'Salvatore', lastName: 'Bruno', role: 'operaio' as const, phone: '3886667788', email: 's.bruno@email.it', fiscalCode: 'BRNSVT90G01F205E', contractType: 'dipendente' as const, dailyRate: 150, hireDate: '2023-02-15', active: true, address: 'Via Pascoli 3', city: 'Cologno', emergencyContact: 'Giovanna Bruno 3886667799', certifications: ['Primo Soccorso'], notes: 'In prova', createdAt: now },
  ]

  const projects = [
    { id: 'p1', name: 'Ristrutturazione Villa Rossi', code: 'PRJ-2024-001', clientId: 'c1', address: 'Via Roma 10', city: 'Milano', description: 'Ristrutturazione completa villa bifamiliare con rifacimento impianti', status: 'in_corso' as const, phase: 'finiture' as const, startDate: '2024-03-01', endDate: '2024-09-30', budget: 185000, progress: 72, managerId: 'w1', workers: ['w1', 'w2', 'w3', 'w6'], notes: 'Cliente esigente, rispettare i tempi', createdAt: now, updatedAt: now },
    { id: 'p2', name: 'Capannone Industriale Bianchi', code: 'PRJ-2024-002', clientId: 'c2', address: 'Via Garibaldi 45', city: 'Torino', description: 'Costruzione nuovo capannone industriale 2000mq', status: 'in_corso' as const, phase: 'struttura' as const, startDate: '2024-01-15', endDate: '2024-12-31', budget: 620000, progress: 45, managerId: 'w1', workers: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'], notes: 'Progetto principale anno 2024', createdAt: now, updatedAt: now },
    { id: 'p3', name: 'Scuola Elementare Bergamo', code: 'PRJ-2024-003', clientId: 'c3', address: 'Via Verdi 5', city: 'Bergamo', description: 'Riqualificazione energetica edificio scolastico', status: 'pianificato' as const, phase: 'progettazione' as const, startDate: '2024-10-01', endDate: '2025-06-30', budget: 280000, progress: 5, managerId: 'w1', workers: ['w1', 'w4', 'w5'], notes: 'Lavori da svolgere in periodo estivo', createdAt: now, updatedAt: now },
    { id: 'p4', name: 'Appartamento Verdi', code: 'PRJ-2023-015', clientId: 'c4', address: 'Corso Italia 22', city: 'Roma', description: 'Ristrutturazione appartamento 90mq', status: 'completato' as const, phase: 'collaudo' as const, startDate: '2023-06-01', endDate: '2023-11-30', budget: 65000, progress: 100, managerId: 'w1', workers: ['w2', 'w4', 'w5'], notes: 'Completato nei tempi previsti', createdAt: now, updatedAt: now },
  ]

  const tasks = [
    { id: 't1', projectId: 'p1', title: 'Posa pavimento piano terra', description: 'Posa parquet rovere spazzolato 150mq', assignedTo: ['w2', 'w6'], status: 'in_corso' as const, priority: 'alta' as const, startDate: '2024-07-01', dueDate: '2024-07-20', createdAt: now },
    { id: 't2', projectId: 'p1', title: 'Pittura pareti interni', description: 'Doppia mano di pittura con fondo', assignedTo: ['w6'], status: 'da_fare' as const, priority: 'media' as const, startDate: '2024-07-21', dueDate: '2024-08-10', createdAt: now },
    { id: 't3', projectId: 'p1', title: 'Installazione impianto elettrico', description: 'Cablaggio e installazione punti luce', assignedTo: ['w4'], status: 'completata' as const, priority: 'alta' as const, startDate: '2024-05-01', dueDate: '2024-06-15', completedAt: '2024-06-12', createdAt: now },
    { id: 't4', projectId: 'p2', title: 'Getto calcestruzzo fondazioni', description: 'Colata fondazioni plinti e travi', assignedTo: ['w2', 'w3', 'w6'], status: 'completata' as const, priority: 'urgente' as const, startDate: '2024-02-01', dueDate: '2024-03-15', completedAt: '2024-03-10', createdAt: now },
    { id: 't5', projectId: 'p2', title: 'Montaggio struttura acciaio', description: 'Assemblaggio capriate e colonne', assignedTo: ['w3'], status: 'in_corso' as const, priority: 'urgente' as const, startDate: '2024-04-01', dueDate: '2024-08-31', createdAt: now },
    { id: 't6', projectId: 'p2', title: 'Impianto idraulico', description: 'Rete idrica e scarichi capannone', assignedTo: ['w5'], status: 'da_fare' as const, priority: 'media' as const, startDate: '2024-09-01', dueDate: '2024-10-31', createdAt: now },
  ]

  const materials = [
    { id: 'm1', name: 'Calcestruzzo C25/30', category: 'Calcestruzzo', unit: 'm³', unitPrice: 95, supplierId: 's1', stock: 45, minStock: 20, code: 'CAL-C25', notes: '', createdAt: now },
    { id: 'm2', name: 'Ferro da 16mm', category: 'Ferro e acciaio', unit: 'kg', unitPrice: 1.20, supplierId: 's2', stock: 2500, minStock: 500, code: 'FER-16', notes: '', createdAt: now },
    { id: 'm3', name: 'Mattoni pieni 25x12x6', category: 'Laterizi', unit: 'pz', unitPrice: 0.45, supplierId: 's3', stock: 8000, minStock: 2000, code: 'MAT-PL25', notes: '', createdAt: now },
    { id: 'm4', name: 'Cemento Portland 42.5', category: 'Leganti', unit: 'sacco 25kg', unitPrice: 8.50, supplierId: 's3', stock: 120, minStock: 50, code: 'CEM-42', notes: '', createdAt: now },
    { id: 'm5', name: 'Sabbia vagliata', category: 'Inerti', unit: 'm³', unitPrice: 22, supplierId: 's3', stock: 30, minStock: 15, code: 'SAB-VAG', notes: '', createdAt: now },
    { id: 'm6', name: 'Ghiaia 10/20mm', category: 'Inerti', unit: 'm³', unitPrice: 18, supplierId: 's3', stock: 5, minStock: 10, code: 'GHI-10', notes: 'SOTTO SCORTA MINIMA', createdAt: now },
    { id: 'm7', name: 'Pannello isolante 10cm', category: 'Isolanti', unit: 'm²', unitPrice: 12.50, supplierId: 's3', stock: 350, minStock: 100, code: 'ISO-10', notes: '', createdAt: now },
    { id: 'm8', name: 'Cavo elettrico FG16OR16', category: 'Impianti elettrici', unit: 'm', unitPrice: 3.80, supplierId: 's4', stock: 800, minStock: 200, code: 'CAV-FG16', notes: '', createdAt: now },
  ]

  const materialOrders = [
    { id: 'mo1', materialId: 'm1', projectId: 'p2', supplierId: 's1', quantity: 80, unitPrice: 92, totalPrice: 7360, orderDate: '2024-01-20', deliveryDate: '2024-01-28', status: 'consegnato' as const, notes: 'Prima fornitura fondazioni', createdAt: now },
    { id: 'mo2', materialId: 'm2', projectId: 'p2', supplierId: 's2', quantity: 5000, unitPrice: 1.15, totalPrice: 5750, orderDate: '2024-01-22', deliveryDate: '2024-02-05', status: 'consegnato' as const, notes: '', createdAt: now },
    { id: 'mo3', materialId: 'm6', projectId: 'p1', supplierId: 's3', quantity: 25, unitPrice: 18, totalPrice: 450, orderDate: '2024-07-10', deliveryDate: '2024-07-15', status: 'ordinato' as const, notes: 'URGENTE - scorta esaurita', createdAt: now },
  ]

  const invoices = [
    { id: 'inv1', number: 'FT-2024-001', clientId: 'c1', projectId: 'p1', issueDate: '2024-03-31', dueDate: '2024-04-30', status: 'pagata' as const, items: [{ id: 'ii1', description: 'SAL 1 - Lavori muratura e demolizioni', quantity: 1, unitPrice: 35000, total: 35000 }, { id: 'ii2', description: 'Materiali forniti', quantity: 1, unitPrice: 8500, total: 8500 }], subtotal: 43500, vatRate: 22, vatAmount: 9570, total: 53070, notes: 'Primo SAL', paidDate: '2024-04-25', createdAt: now },
    { id: 'inv2', number: 'FT-2024-002', clientId: 'c2', projectId: 'p2', issueDate: '2024-04-30', dueDate: '2024-05-30', status: 'pagata' as const, items: [{ id: 'ii3', description: 'SAL 1 - Opere di fondazione', quantity: 1, unitPrice: 85000, total: 85000 }, { id: 'ii4', description: 'Calcestruzzo e ferro', quantity: 1, unitPrice: 22000, total: 22000 }], subtotal: 107000, vatRate: 22, vatAmount: 23540, total: 130540, notes: '', paidDate: '2024-05-28', createdAt: now },
    { id: 'inv3', number: 'FT-2024-003', clientId: 'c1', projectId: 'p1', issueDate: '2024-06-30', dueDate: '2024-07-30', status: 'inviata' as const, items: [{ id: 'ii5', description: 'SAL 2 - Impianti e struttura', quantity: 1, unitPrice: 42000, total: 42000 }, { id: 'ii6', description: 'Materiali e posa', quantity: 1, unitPrice: 11000, total: 11000 }], subtotal: 53000, vatRate: 22, vatAmount: 11660, total: 64660, notes: 'In attesa di pagamento', createdAt: now },
    { id: 'inv4', number: 'FT-2024-004', clientId: 'c2', projectId: 'p2', issueDate: '2024-07-01', dueDate: '2024-07-31', status: 'scaduta' as const, items: [{ id: 'ii7', description: 'SAL 2 - Struttura acciaio', quantity: 1, unitPrice: 95000, total: 95000 }], subtotal: 95000, vatRate: 22, vatAmount: 20900, total: 115900, notes: 'SOLLECITARE PAGAMENTO', createdAt: now },
  ]

  const expenses = [
    { id: 'exp1', projectId: 'p1', category: 'materiali' as const, description: 'Acquisto parquet rovere spazzolato 150mq', amount: 6750, date: '2024-06-28', supplierId: 's3', approved: true, approvedBy: 'w1', notes: '', createdAt: now },
    { id: 'exp2', projectId: 'p2', category: 'materiali' as const, description: 'Acciaio strutturale HEA 240', amount: 18500, date: '2024-04-15', supplierId: 's2', approved: true, approvedBy: 'w1', notes: '', createdAt: now },
    { id: 'exp3', projectId: 'p2', category: 'noleggi' as const, description: 'Noleggio gru 50t per 30 giorni', amount: 9000, date: '2024-04-01', approved: true, approvedBy: 'w1', notes: 'Include operatore', createdAt: now },
    { id: 'exp4', projectId: 'p1', category: 'manodopera' as const, description: 'Retribuzioni operai luglio', amount: 12400, date: '2024-07-31', approved: true, approvedBy: 'w1', notes: '', createdAt: now },
    { id: 'exp5', projectId: 'p2', category: 'subappalti' as const, description: 'Subappalto carpenteria metallica', amount: 28000, date: '2024-05-01', approved: true, approvedBy: 'w1', notes: 'Ditta Metalli Srl', createdAt: now },
    { id: 'exp6', projectId: 'p2', category: 'trasporti' as const, description: 'Trasporto travi acciaio', amount: 1200, date: '2024-04-20', approved: false, notes: 'In attesa approvazione', createdAt: now },
  ]

  const attendances = [
    { id: 'att1', workerId: 'w1', projectId: 'p1', date: '2024-07-08', status: 'presente' as const, hoursWorked: 8, overtime: 0, notes: '' },
    { id: 'att2', workerId: 'w2', projectId: 'p1', date: '2024-07-08', status: 'presente' as const, hoursWorked: 8, overtime: 1, notes: '' },
    { id: 'att3', workerId: 'w3', projectId: 'p2', date: '2024-07-08', status: 'presente' as const, hoursWorked: 8, overtime: 2, notes: '' },
    { id: 'att4', workerId: 'w4', projectId: 'p1', date: '2024-07-08', status: 'ferie' as const, hoursWorked: 0, overtime: 0, notes: 'Ferie estive' },
    { id: 'att5', workerId: 'w5', projectId: 'p2', date: '2024-07-08', status: 'presente' as const, hoursWorked: 8, overtime: 0, notes: '' },
    { id: 'att6', workerId: 'w6', projectId: 'p1', date: '2024-07-08', status: 'malattia' as const, hoursWorked: 0, overtime: 0, notes: 'Certificato medico' },
    { id: 'att7', workerId: 'w1', projectId: 'p2', date: '2024-07-09', status: 'presente' as const, hoursWorked: 8, overtime: 0, notes: '' },
    { id: 'att8', workerId: 'w2', projectId: 'p1', date: '2024-07-09', status: 'presente' as const, hoursWorked: 8, overtime: 0, notes: '' },
  ]

  const documents = [
    { id: 'd1', projectId: 'p1', name: 'Contratto appalto Villa Rossi', type: 'PDF', category: 'contratto' as const, uploadDate: '2024-02-28', expiryDate: undefined, notes: '', createdAt: now },
    { id: 'd2', projectId: 'p1', name: 'Permesso di costruire PR-2024-0234', type: 'PDF', category: 'permesso' as const, uploadDate: '2024-02-10', expiryDate: '2025-02-10', notes: 'Permesso rilasciato dal Comune', createdAt: now },
    { id: 'd3', projectId: 'p2', name: 'Progetto esecutivo capannone', type: 'DWG', category: 'progetto' as const, uploadDate: '2024-01-05', notes: 'Rev. 3 - Definitivo', createdAt: now },
    { id: 'd4', name: 'Piano di Sicurezza Cantiere 2024', type: 'PDF', category: 'sicurezza' as const, uploadDate: '2024-01-01', expiryDate: '2024-12-31', notes: 'DVR aggiornato', createdAt: now },
    { id: 'd5', projectId: 'p4', name: 'Certificato di collaudo App. Verdi', type: 'PDF', category: 'collaudo' as const, uploadDate: '2023-12-01', notes: 'Collaudo positivo', createdAt: now },
  ]

  return { projects, tasks, workers, attendances, clients, suppliers, materials, materialOrders, invoices, expenses, documents }
}
