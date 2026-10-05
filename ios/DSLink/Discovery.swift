import Foundation
import Network
import UIKit

struct Room: Identifiable, Equatable {
    var id: String { sessionId.isEmpty ? "\(ip):\(port)" : sessionId }
    var name = "", game = "", ip = "", sessionId = "", mode = "", app = "", core = ""
    var port = 0, players = 1, max = 4, proto = 0
}

enum DiscoveryState: Equatable {
    case idle, searching
    /// The user refused (or never granted) the Local Network permission: show "Apri Impostazioni".
    case localNetworkDenied
    case failed(String)
}

/// Bonjour discovery of "_dslink._tcp" rooms (interoperable with Android NSD). Requires the Local Network
/// permission (NSLocalNetworkUsageDescription + NSBonjourServices in Info.plist). The room's IP and port travel in
/// the TXT record, so no extra resolve step is needed.
final class RoomBrowser: ObservableObject {
    @Published var rooms: [Room] = []
    @Published var state: DiscoveryState = .idle
    private var browser: NWBrowser?

    func start() {
        stop()
        let params = NWParameters()
        params.includePeerToPeer = true
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "\(AppInfo.serviceType)", domain: nil), using: params)
        b.stateUpdateHandler = { [weak self] st in
            DispatchQueue.main.async {
                switch st {
                case .ready: self?.state = .searching
                case .waiting(let err), .failed(let err):
                    if Self.isPolicyDenied(err) { self?.state = .localNetworkDenied }
                    else { self?.state = .failed("\(err)") }
                    Native.log("[discovery] \(st)")
                default: break
                }
            }
        }
        b.browseResultsChangedHandler = { [weak self] results, _ in
            let list = results.compactMap { Self.room(from: $0) }.sorted { $0.name < $1.name }
            DispatchQueue.main.async { self?.rooms = list }
        }
        browser = b
        state = .searching
        b.start(queue: .main)
    }

    func stop() {
        browser?.cancel()
        browser = nil
        rooms = []
        state = .idle
    }

    private static func isPolicyDenied(_ err: NWError) -> Bool {
        if case .dns(let code) = err { return code == -65570 }  // kDNSServiceErr_PolicyDenied
        return false
    }

    private static func room(from r: NWBrowser.Result) -> Room? {
        guard case .bonjour(let txt) = r.metadata else { return nil }
        let d = txt.dictionary
        guard let ip = d["ip"], let port = Int(d["port"] ?? ""), Names.isValidIPv4(ip), Names.isValidPort(port) else { return nil }
        var room = Room()
        room.name = d["room"] ?? ""
        room.game = d["game"] ?? ""
        room.ip = ip
        room.port = port
        room.sessionId = d["session"] ?? ""
        room.mode = d["mode"] ?? ""
        room.app = d["app"] ?? ""
        room.core = d["core"] ?? ""
        room.proto = Int(d["proto"] ?? "") ?? 0
        room.players = Int(d["players"] ?? "") ?? 1
        room.max = Int(d["max"] ?? "") ?? 4
        return room
    }
}

/// Publishes the host's room. NetService advertises a port without binding it, so it never collides with the TCP
/// port RetroArch's Netplay server uses.
final class RoomAdvertiser: NSObject, NetServiceDelegate {
    private var service: NetService?

    func start(advert: [String: String]) {
        stop()
        let port = Int32(advert["port"] ?? "") ?? Int32(AppInfo.defaultPort)
        let s = NetService(domain: "", type: "\(AppInfo.serviceType).", name: advert["room"] ?? "DSLink", port: port)
        var txt: [String: Data] = [:]
        for k in ["proto", "app", "core", "room", "game", "session", "host", "mode", "console", "players", "max", "ip", "port"] {
            if let v = advert[k] { txt[k] = Data(v.utf8) }
        }
        s.setTXTRecord(NetService.data(fromTXTRecord: txt))
        s.delegate = self
        s.publish()
        service = s
    }

    func update(players: Int) {
        guard let s = service else { return }
        var txt = NetService.dictionary(fromTXTRecord: s.txtRecordData() ?? Data())
        txt["players"] = Data(String(players).utf8)
        s.setTXTRecord(NetService.data(fromTXTRecord: txt))
    }

    func stop() {
        service?.stop()
        service = nil
    }

    func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) {
        Native.log("[discovery] publish failed \(errorDict)")
    }
}

func openAppSettings() {
    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
}
