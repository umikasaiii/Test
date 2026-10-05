import Foundation
import SwiftUI

struct Game: Codable, Identifiable, Equatable {
    var id: String { path }
    var path: String
    var title: String
    var sha256: String
}

/// App-private storage: ROMs, the user's own system files and saves never leave the device.
final class Store: ObservableObject {
    @Published var recent: [Game] = []
    @Published var identity: [String: String] = [:]
    @Published var systemStatus: [String: String] = [:]

    let base: URL
    var systemDir: URL { base.appendingPathComponent("system/melonDS DS", isDirectory: true) }
    var romsDir: URL { base.appendingPathComponent("roms", isDirectory: true) }
    var identityFile: String { base.appendingPathComponent("identity.txt").path }

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        base = support.appendingPathComponent("dslink", isDirectory: true)
        for d in ["roms", "system/melonDS DS", "saves", "states", "config", "info", "overlay"] {
            try? FileManager.default.createDirectory(at: base.appendingPathComponent(d), withIntermediateDirectories: true)
        }
        var b = base
        var rv = URLResourceValues()
        rv.isExcludedFromBackup = true  // ROMs / system files are the user's; never put them in iCloud backups
        try? b.setResourceValues(rv)
        reload()
    }

    func reload() {
        identity = Native.identity(path: identityFile)
        systemStatus = Native.validateSystemDir(systemDir.path)
        if let data = UserDefaults.standard.data(forKey: "recent"),
           let games = try? JSONDecoder().decode([Game].self, from: data) {
            recent = games.filter { FileManager.default.fileExists(atPath: $0.path) }
        }
    }

    var playerName: String { identity["player_name"] ?? "Player" }
    var systemReady: Bool { systemStatus["ready"] == "1" }

    func addRecent(_ g: Game) {
        var list = recent.filter { $0.path != g.path }
        list.insert(g, at: 0)
        recent = Array(list.prefix(8))
        if let d = try? JSONEncoder().encode(recent) { UserDefaults.standard.set(d, forKey: "recent") }
    }

    func rename(_ name: String) -> Bool {
        guard Native.rename(path: identityFile, name: name) != nil else { return false }
        reload()
        return true
    }

    // MARK: imports (security-scoped URLs from the document picker)

    func importRom(_ url: URL) -> Result<Game, StoreError> {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard url.pathExtension.lowercased() == "nds" else { return .failure(.msg("Seleziona un file .nds (ROM Nintendo DS).")) }
        let name = Names.safeName(url.lastPathComponent)
        let dest = romsDir.appendingPathComponent(name)
        do {
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.copyItem(at: url, to: dest)
        } catch {
            return .failure(.msg("Impossibile copiare il file sul dispositivo."))
        }
        let info = Native.ndsInfo(path: dest.path)
        guard info["status"] == "OK" else {
            try? FileManager.default.removeItem(at: dest)
            return .failure(.msg(info["message"] ?? "ROM non valida."))
        }
        let title = (info["title"]?.isEmpty == false) ? info["title"]! : name
        let g = Game(path: dest.path, title: title, sha256: info["sha256"] ?? "")
        addRecent(g)
        return .success(g)
    }

    func importSystemFile(_ url: URL) -> String {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        guard let target = Names.systemFileName(forSize: size) else {
            return "\(url.lastPathComponent): dimensione non valida, il file non proviene da un Nintendo DS."
        }
        let dest = systemDir.appendingPathComponent(target)
        do {
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.copyItem(at: url, to: dest)
        } catch { return "Impossibile leggere \(url.lastPathComponent)" }
        let status = Native.validateSystemDir(systemDir.path)
        let key = String(target.dropLast(4))
        if status[key] == "OK" { reload(); return "\(target) importato." }
        try? FileManager.default.removeItem(at: dest)
        reload()
        return status["\(key)_msg"] ?? "\(target) non valido."
    }
}

enum StoreError: Error { case msg(String)
    var text: String { if case .msg(let m) = self { return m } else { return "" } }
}

/// Pure helpers (unit-tested).
enum Names {
    static func systemFileName(forSize size: Int) -> String? {
        switch size {
        case 0x4000: return "bios7.bin"
        case 0x1000: return "bios9.bin"
        case 0x20000, 0x40000, 0x80000: return "firmware.bin"
        default: return nil
        }
    }

    static func safeName(_ n: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._ -()")
        let s = String(n.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" })
        return s.isEmpty ? "file" : s
    }

    static func isValidIPv4(_ s: String) -> Bool {
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        for p in parts {
            guard !p.isEmpty, p.count <= 3, p.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
            if p.count > 1 && p.hasPrefix("0") { return false }
            guard let v = Int(p), v <= 255 else { return false }
        }
        return true
    }

    static func isValidPort(_ p: Int) -> Bool { p >= 1024 && p <= 65535 }
}
