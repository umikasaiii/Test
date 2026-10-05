import SwiftUI
import UniformTypeIdentifiers

private let card = Color(red: 0.10, green: 0.11, blue: 0.14)

struct BigButton: View {
    let title: String
    var primary = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.headline).frame(maxWidth: .infinity, minHeight: 56)
        }
        .buttonStyle(.borderedProminent)
        .tint(primary ? .accentColor : card)
        .foregroundStyle(.white)
    }
}

struct AlertMessage: Identifiable { let id = UUID(); let title: String; let text: String }

// MARK: - Home

struct HomeView: View {
    @EnvironmentObject var store: Store
    @State private var picking = false
    @State private var pendingAction = "play"
    @State private var alert: AlertMessage?
    @State private var hostGame: Game?
    @State private var showJoin = false
    @State private var showSettings = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("DSLink").font(.system(size: 36, weight: .bold))
                Text("Nintendo DS").foregroundStyle(.secondary)
                Spacer().frame(height: 12)
                BigButton(title: "Apri gioco", primary: true) { pendingAction = "play"; picking = true }

                Text("MULTIPLAYER").font(.caption.bold()).foregroundStyle(.secondary).padding(.top, 16)
                BigButton(title: "Crea partita") {
                    if let g = store.recent.first { hostGame = g } else { pendingAction = "host"; picking = true }
                }
                BigButton(title: "Unisciti") { showJoin = true }
                if let g = store.recent.first {
                    Text("Gioco per \"Crea partita\": \(g.title)").font(.footnote).foregroundStyle(.secondary)
                }

                if !store.recent.isEmpty {
                    Text("ULTIMI GIOCHI").font(.caption.bold()).foregroundStyle(.secondary).padding(.top, 16)
                    ForEach(store.recent) { g in
                        Menu {
                            Button("Gioca") { play(g) }
                            Button("Crea partita") { hostGame = g }
                        } label: {
                            Text(g.title).font(.headline).frame(maxWidth: .infinity, minHeight: 56)
                                .background(card).clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                    }
                }
                BigButton(title: "Impostazioni") { showSettings = true }.padding(.top, 24)
            }
            .padding(20)
        }
        .navigationDestination(isPresented: Binding(get: { hostGame != nil }, set: { if !$0 { hostGame = nil } })) {
            if let g = hostGame { HostView(game: g) }
        }
        .navigationDestination(isPresented: $showJoin) { JoinView() }
        .navigationDestination(isPresented: $showSettings) { SettingsView() }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.data], allowsMultipleSelection: false) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            switch store.importRom(url) {
            case .failure(let e): alert = AlertMessage(title: "ROM non valida", text: e.text)
            case .success(let g): if pendingAction == "host" { hostGame = g } else { play(g) }
            }
        }
        .alert(item: $alert) { Alert(title: Text($0.title), message: Text($0.text)) }
    }

    private func play(_ g: Game) {
        store.addRecent(g)
        if let err = EmulatorLauncher.launch(role: "single", game: g, hostIP: "", port: AppInfo.defaultPort, store: store) {
            alert = AlertMessage(title: "Emulatore", text: err)
        }
    }
}

// MARK: - Host

struct HostView: View {
    let game: Game
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @State private var session: HostSession?
    @State private var error: String?
    @State private var showDetails = false
    @State private var alert: AlertMessage?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(game.title).font(.system(size: 30, weight: .bold))
                if let error = error {
                    Text(error).foregroundStyle(.red)
                    BigButton(title: "Riprova", primary: true) { start() }
                } else if let s = session {
                    Text(s.advert["room"] ?? "").foregroundStyle(.secondary)
                    PlayersCard(session: s)
                    if showDetails {
                        Text("IP: \(s.advert["ip"] ?? "")\nPorta: \(s.advert["port"] ?? "")").font(.body.monospaced())
                    }
                    BigButton(title: "Mostra dati connessione") { showDetails.toggle() }
                    Text("Quando i giocatori sono entrati, tocca \"Avvia gioco\", poi nel gioco scegli Multiplayer. Gli altri dispositivi entreranno con DS Download Play.")
                        .font(.footnote).foregroundStyle(.secondary)
                    BigButton(title: "Avvia gioco", primary: true) {
                        s.markGameStarted()
                        if let err = EmulatorLauncher.launch(role: "host", game: game, hostIP: "", port: s.port, store: store) {
                            alert = AlertMessage(title: "Emulatore", text: err)
                        }
                    }
                    BigButton(title: "Termina stanza") { s.stop(); dismiss() }
                } else {
                    ProgressView("Creazione stanza…")
                }
            }
            .padding(20)
        }
        .onAppear { if session == nil && error == nil { start() } }
        .onDisappear { session?.stop() }
        .alert(item: $alert) { Alert(title: Text($0.title), message: Text($0.text)) }
    }

    private func start() {
        error = nil
        switch HostSession.start(game: game, store: store) {
        case .success(let s): session = s
        case .failure(let e): error = e.text
        }
    }
}

struct PlayersCard: View {
    @ObservedObject var session: HostSession
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(session.players.isEmpty ? "In attesa di giocatori…" : "Giocatori connessi").font(.title3.bold())
            Text("\(1 + session.players.count)/4").font(.system(size: 34, weight: .bold)).foregroundStyle(Color.accentColor)
            Text("Tu (host)").foregroundStyle(.secondary)
            ForEach(session.players, id: \.self) { Text($0).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(18)
        .background(card).clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

// MARK: - Join

struct JoinView: View {
    @EnvironmentObject var store: Store
    @StateObject private var browser = RoomBrowser()
    @StateObject private var flow = JoinFlow()
    @State private var manual = false
    @State private var ip = ""
    @State private var port = "\(AppInfo.defaultPort)"
    @State private var alert: AlertMessage?
    @State private var joined: (String, Int)?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Unisciti").font(.system(size: 34, weight: .bold))
                switch flow.step {
                case .idle: list
                case .checking: ProgressView("Controllo della stanza…")
                case .testing(let t): VStack(alignment: .leading) { ProgressView(); Text(t) }
                case .waitingHost: ProgressView("In attesa che l'host avvii il gioco…")
                case .ready:
                    Text("Si aprirà il menu del Nintendo DS. Tocca \"DS Download Play\" e scegli il gioco dell'host.")
                    BigButton(title: "Continua", primary: true) { boot() }
                case .failed(let title, let msg):
                    Text(title).font(.title2.bold())
                    Text(msg).foregroundStyle(.red)
                    BigButton(title: "OK", primary: true) { flow.step = .idle; browser.start() }
                }
                if flow.step != .idle {
                    BigButton(title: "Annulla") { flow.cancel(); flow.step = .idle; browser.start() }
                }
            }.padding(20)
        }
        .onAppear { browser.start() }
        .onDisappear { browser.stop(); flow.cancel(); if let j = joined { Native.bye(ip: j.0, port: j.1, deviceId: store.identity["device_id"] ?? "") } }
        .alert(item: $alert) { Alert(title: Text($0.title), message: Text($0.text)) }
        .sheet(isPresented: $manual) { manualSheet }
    }

    @ViewBuilder private var list: some View {
        switch browser.state {
        case .localNetworkDenied:
            VStack(alignment: .leading, spacing: 10) {
                Text("Accesso alla rete locale disattivato").font(.title3.bold()).foregroundStyle(.orange)
                Text("DSLink deve trovare gli altri giocatori sulla tua rete locale. Attiva \"Rete locale\" per DSLink nelle Impostazioni di iOS.")
                BigButton(title: "Apri Impostazioni", primary: true) { openAppSettings() }
            }
        case .failed(let m): Text("Ricerca non riuscita: \(m)").foregroundStyle(.red)
        default: Text(browser.rooms.isEmpty ? "Ricerca in corso…" : "\(browser.rooms.count) partite trovate").foregroundStyle(.secondary)
        }
        Text("PARTITE VICINE").font(.caption.bold()).foregroundStyle(.secondary).padding(.top, 8)
        ForEach(browser.rooms) { r in
            VStack(alignment: .leading, spacing: 4) {
                Text(r.game.isEmpty ? "Nintendo DS" : r.game).font(.title3.bold())
                Text(r.name).foregroundStyle(.secondary)
                Text("\(r.players)/\(r.max) giocatori").font(.footnote).foregroundStyle(.secondary)
                BigButton(title: "ENTRA", primary: true) { join(ip: r.ip, port: r.port) }
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(card).clipShape(RoundedRectangle(cornerRadius: 16))
        }
        Text("NON LA TROVI?").font(.caption.bold()).foregroundStyle(.secondary).padding(.top, 8)
        BigButton(title: "Inserisci IP manualmente") { manual = true }
        Text("Controlla che entrambi i dispositivi siano sulla stessa rete Wi-Fi (non \"ospiti\") o che uno usi l'hotspot dell'altro.")
            .font(.footnote).foregroundStyle(.secondary)
    }

    private var manualSheet: some View {
        NavigationStack {
            Form {
                TextField("IP (es. 192.168.1.20)", text: $ip).keyboardType(.numbersAndPunctuation)
                TextField("Porta", text: $port).keyboardType(.numberPad)
                Button("Connetti") {
                    guard Names.isValidIPv4(ip), let p = Int(port), Names.isValidPort(p) else {
                        alert = AlertMessage(title: "Dati non validi", text: "Inserisci un indirizzo IPv4 valido e una porta tra 1024 e 65535.")
                        return
                    }
                    manual = false
                    join(ip: ip, port: p)
                }
            }.navigationTitle("Connessione manuale")
        }
    }

    private func join(ip: String, port: Int) {
        guard store.systemReady else {
            alert = AlertMessage(title: "File di sistema mancanti",
                                 text: "Per usare DS Download Play serve il firmware del tuo Nintendo DS. Importalo da Impostazioni → File di sistema Nintendo DS.")
            return
        }
        browser.stop()
        joined = (ip, port)
        flow.run(ip: ip, port: port, store: store) {}
    }

    private func boot() {
        guard let j = joined else { return }
        if let err = EmulatorLauncher.launch(role: "client", game: nil, hostIP: j.0, port: j.1, store: store) {
            alert = AlertMessage(title: "Emulatore", text: err)
        }
    }
}

// MARK: - Settings & diagnostics

struct SettingsView: View {
    @EnvironmentObject var store: Store
    @State private var name = ""
    @State private var picking = false
    @State private var message: AlertMessage?
    @State private var advanced = false

    var body: some View {
        Form {
            Section("Giocatore") {
                TextField("Nome", text: $name).onSubmit { save() }
                Button("Salva nome") { save() }
            }
            Section(header: Text("File di sistema Nintendo DS"),
                    footer: Text("I file devono provenire dal tuo Nintendo DS. Restano solo su questo dispositivo.")) {
                ForEach(["bios7", "bios9", "firmware"], id: \.self) { k in
                    let ok = store.systemStatus[k] == "OK"
                    Label("\(k).bin", systemImage: ok ? "checkmark.circle.fill" : "xmark.circle")
                        .foregroundStyle(ok ? .green : .secondary)
                }
                Button("Importa file di sistema") { picking = true }
            }
            Section("Avanzate") {
                Toggle("Mostra opzioni avanzate", isOn: $advanced)
                if advanced {
                    Text("DSLink \(AppInfo.appVersion)\n\(AppInfo.retroarchVersion) · \(AppInfo.coreVersion)\nRete: solo LAN. Nessun server, account o telemetria.")
                        .font(.footnote)
                    NavigationLink("Diagnostica multiplayer") { DiagnosticsView() }
                }
            }
            Section("Informazioni") {
                Text("DSLink è software libero (GPLv3) basato su RetroArch e melonDS DS. Non include ROM, BIOS o firmware Nintendo.")
                    .font(.footnote)
            }
        }
        .navigationTitle("Impostazioni")
        .onAppear { name = store.playerName; store.reload() }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.data], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            let lines = urls.map { store.importSystemFile($0) }
            message = AlertMessage(title: "Importazione", text: lines.joined(separator: "\n"))
        }
        .alert(item: $message) { Alert(title: Text($0.title), message: Text($0.text)) }
    }

    private func save() {
        if !store.rename(name.trimmingCharacters(in: .whitespaces)) {
            message = AlertMessage(title: "Nome non valido", text: "Il nome deve avere da 1 a 24 caratteri.")
        }
    }
}

struct DiagnosticsView: View {
    @EnvironmentObject var store: Store
    @State private var text = ""

    var body: some View {
        ScrollView {
            Text(text).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding()
        }
        .navigationTitle("Diagnostica")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Copia log") { UIPasteboard.general.string = text }
            }
        }
        .onAppear { refresh() }
    }

    private func refresh() {
        let lan = Native.bestIPv4()
        let id = store.identity
        text = Native.diagnostics([
            "platform": "iOS \(UIDevice.current.systemVersion)", "dslink_version": AppInfo.appVersion,
            "retroarch_version": AppInfo.retroarchVersion, "core_version": AppInfo.coreVersion,
            "player_id": id["device_id"] ?? "", "mac": id["mac"] ?? "", "ipv4": lan["ip"] ?? "",
            "subnet": lan["found"] == "1" ? "\(lan["ip"] ?? "")/\(lan["prefix"] ?? "")" : "",
            "connection_type": (lan["kind"] ?? "nessuna rete") + (lan["vpn"] == "1" ? " (VPN attiva)" : ""),
            "firmware": store.systemReady ? "1" : "0", "rom_loaded": store.recent.isEmpty ? "0" : "1",
            "rom_sha256": store.recent.first?.sha256 ?? "",
        ])
    }
}
