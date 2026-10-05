import Foundation
import Network
import SwiftUI

/// Host session: control server + beacon (native) + Bonjour advert + state machine.
final class HostSession: ObservableObject {
    @Published var players: [String] = []
    @Published var error: String?
    let advert: [String: String]
    let port: Int
    private var server: UnsafeMutableRawPointer?
    private var sm: UnsafeMutableRawPointer?
    private let advertiser = RoomAdvertiser()
    private var timer: Timer?

    static func start(game: Game, store: Store) -> Result<HostSession, StoreError> {
        let lan = Native.bestIPv4()
        guard lan["found"] == "1", let ip = lan["ip"] else {
            return .failure(.msg("Non sei connesso a una rete locale.\nConnettiti alla stessa Wi-Fi degli altri giocatori o attiva l'hotspot."))
        }
        let port = Native.pickPort(AppInfo.defaultPort)
        guard port != 0 else { return .failure(.msg("Nessuna porta di rete disponibile (porta occupata).")) }
        let id = store.identity
        let advert: [String: String] = [
            "proto": "\(AppInfo.protocolVersion)", "app": AppInfo.appVersion, "core": AppInfo.coreVersion,
            "room": "Stanza di \(store.playerName)", "ip": ip, "port": "\(port)", "game": game.title,
            "session": String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12)),
            "host": id["device_id"] ?? "", "mode": "download-play", "console": "nds", "players": "1", "max": "4",
        ]
        let s = HostSession(advert: advert, port: port)
        s.sm = Native.smNew()
        if let sm = s.sm { Native.smEvent(sm, "StartHost") }
        guard let h = Native.hostStart(advert: advert, nick: id["nick"] ?? "", mac: id["mac"] ?? "", port: port, beacon: false) else {
            if let sm = s.sm { Native.smEvent(sm, "Fail", Native.lastError) }
            return .failure(.msg(Native.lastError.contains("occupata") ? "Porta occupata. Riprova." : "Impossibile avviare la stanza (\(Native.lastError))."))
        }
        s.server = h
        s.advertiser.start(advert: advert)
        if let sm = s.sm { Native.smEvent(sm, "Prepared") }
        s.timer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { [weak s] _ in s?.poll() }
        return .success(s)
    }

    private init(advert: [String: String], port: Int) {
        self.advert = advert
        self.port = port
    }

    private func poll() {
        guard let h = server else { return }
        let m = Native.hostPeers(h)
        let n = Int(m["count"] ?? "0") ?? 0
        let names = (0..<n).map { "\(m["peer\($0)_nick"] ?? "?") (\(m["peer\($0)_ip"] ?? ""))" }
        if names != players {
            let joined = names.count > players.count
            players = names
            if let sm = sm { Native.smEvent(sm, joined ? "PeerConnected" : "PeerLeft", remaining: names.count) }
            advertiser.update(players: 1 + names.count)
        }
    }

    func markGameStarted() { if let sm = sm { Native.smEvent(sm, "GameStarted") } }

    func stop() {
        timer?.invalidate()
        timer = nil
        advertiser.stop()
        if let h = server { Native.hostStop(h) }
        server = nil
        if let sm = sm { Native.smEvent(sm, "Stop"); Native.smFree(sm) }
        sm = nil
    }
}

enum JoinStep: Equatable {
    case idle, checking, testing(String), waitingHost, ready, failed(String, String)
}

/// Client join sequence: DSLink handshake -> link test -> wait for the host's emulator -> boot DS (Download Play).
final class JoinFlow: ObservableObject {
    @Published var step: JoinStep = .idle
    @Published var quality = ""
    private var cancelled = false

    func cancel() { cancelled = true }

    func run(ip: String, port: Int, store: Store, onReady: @escaping () -> Void) {
        cancelled = false
        step = .checking
        DispatchQueue.global().async { [self] in
            let sm = Native.smNew()
            defer { if let sm = sm { Native.smFree(sm) } }
            if let sm = sm { Native.smEvent(sm, "StartJoin"); Native.smEvent(sm, "Prepared"); Native.smEvent(sm, "RoomSelected", "\(ip):\(port)") }
            var res: [String: String] = [:]
            for _ in 0..<3 {
                let id = store.identity
                let me: [String: String] = [
                    "proto": "\(AppInfo.protocolVersion)", "app": AppInfo.appVersion, "core": AppInfo.coreVersion,
                    "console": "nds", "mode": "download-play", "device": id["device_id"] ?? "", "nick": id["nick"] ?? "",
                ]
                res = Native.hello(ip: ip, port: port, info: me, mac: id["mac"] ?? "")
                if res["code"] == "MAC_CONFLICT" {  // regenerate identity and retry transparently
                    _ = Native.bumpSalt(path: store.identityFile)
                    DispatchQueue.main.sync { store.reload() }
                    continue
                }
                break
            }
            guard res["ok"] == "1" else {
                if let sm = sm { Native.smEvent(sm, "Fail", res["code"] ?? "no answer") }
                let reachable = res["reachable"] == "1"
                let msg = (res["message"]?.isEmpty == false ? res["message"]! : "Impossibile connettersi alla stanza.")
                self.fail(reachable ? "Impossibile entrare" : "Host non raggiungibile",
                          msg + (reachable ? "" : "\n\nSe il problema continua prova l'hotspot di uno dei due dispositivi."))
                return
            }
            if cancelled { return }
            DispatchQueue.main.async { self.step = .testing("Test rete…") }
            let q = Native.probe(ip: ip, port: port)
            let line = "Ping LAN: \(q["avg_ms"] ?? "?") ms\nQualità: \(q["quality_label"] ?? "?")"
            DispatchQueue.main.async { self.step = .testing(line); self.quality = q["quality"] ?? "" }
            Thread.sleep(forTimeInterval: 1.0)
            DispatchQueue.main.async { self.step = .waitingHost }
            var up = false
            for _ in 0..<180 where !cancelled {
                if Self.tcpOpen(ip: ip, port: port) { up = true; break }
                Thread.sleep(forTimeInterval: 0.5)
            }
            if cancelled { return }
            guard up else {
                if let sm = sm { Native.smEvent(sm, "Fail", "host never started") }
                self.fail("Host non pronto", "L'host non ha avviato il gioco entro 90 secondi.")
                return
            }
            if let sm = sm { Native.smEvent(sm, "NetplayConnected"); Native.smEvent(sm, "BootDS") }
            DispatchQueue.main.async { self.step = .ready; onReady() }
        }
    }

    private func fail(_ title: String, _ msg: String) {
        Native.log("[client] \(title) - \(msg.replacingOccurrences(of: "\n", with: " "))")
        DispatchQueue.main.async { self.step = .failed(title, msg) }
    }

    /// Non-blocking TCP connect probe with a 400 ms timeout.
    static func tcpOpen(ip: String, port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        inet_pton(AF_INET, ip, &addr.sin_addr)
        let r = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        if r == 0 { return true }
        guard errno == EINPROGRESS else { return false }
        var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        guard poll(&p, 1, 400) > 0 else { return false }
        var err: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
        return err == 0
    }
}

/// Starts the emulator for a session. The RetroArch iOS front-end is not linked into this build yet: see
/// docs/IOS.md ("Emulator integration status"). Everything up to this call (identity, firmware, discovery,
/// handshake, link test, configuration) is real and exercised.
enum EmulatorLauncher {
    static let isIntegrated = false

    static func launch(role: String, game: Game?, hostIP: String, port: Int, store: Store) -> String? {
        var plan: [String: String] = [
            "role": role == "client" ? "client" : "host", "mode": "download-play", "content": game?.path ?? "",
            "system_dir": store.base.appendingPathComponent("system").path,
            "save_dir": store.base.appendingPathComponent("saves").path,
            "state_dir": store.base.appendingPathComponent("states").path,
            "config_dir": store.base.appendingPathComponent("config").path,
            "info_dir": store.base.appendingPathComponent("info").path,
            "device_id": store.identity["device_id"] ?? "", "player_name": store.playerName,
            "nick_salt": store.identity["nick_salt"] ?? "0", "host_ip": hostIP, "port": "\(port)",
        ]
        plan["core_path"] = ""
        let cfg = Native.launchConfig(plan)
        try? cfg.write(to: store.base.appendingPathComponent("retroarch.cfg"), atomically: true, encoding: .utf8)
        try? Native.launchCoreOptions(plan).write(to: store.base.appendingPathComponent("config/melondsds.opt"), atomically: true, encoding: .utf8)
        Native.log("[launch] \(role) config written; emulator integrated=\(isIntegrated)")
        return isIntegrated ? nil : "Il motore di emulazione (RetroArch + melonDS DS) non è ancora collegato a questa build iOS.\nLa configurazione della sessione è stata preparata correttamente."
    }
}
