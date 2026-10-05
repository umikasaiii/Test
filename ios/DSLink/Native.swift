import Foundation

/// Thin Swift wrapper over the portable C++ DSLink library (dslink/). Structured data is "key=value\n" text.
enum Native {
    static func take(_ p: UnsafeMutablePointer<CChar>?) -> String? {
        guard let p = p else { return nil }
        defer { dslink_free(p) }
        return String(cString: p)
    }

    static func kv(_ text: String?) -> [String: String] {
        var m: [String: String] = [:]
        guard let text = text else { return m }
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let eq = line.firstIndex(of: "="), eq != line.startIndex else { continue }
            m[String(line[line.startIndex..<eq])] = String(line[line.index(after: eq)...])
        }
        return m
    }

    static func encode(_ d: [String: String]) -> String {
        d.keys.sorted().map { k in
            let v = (d[k] ?? "").replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
            return "\(k)=\(v)\n"
        }.joined()
    }

    static var lastError: String { String(cString: dslink_last_error()) }

    // identity
    static func identity(path: String) -> [String: String] { kv(take(dslink_identity_load_or_create(path))) }
    static func rename(path: String, name: String) -> [String: String]? {
        take(dslink_identity_rename(path, name)).map { kv($0) }
    }
    static func bumpSalt(path: String) -> [String: String] { kv(take(dslink_identity_bump_salt(path))) }

    // network / files
    static func bestIPv4() -> [String: String] { kv(take(dslink_best_ipv4())) }
    static func pickPort(_ preferred: Int) -> Int { Int(dslink_pick_port(Int32(preferred))) }
    static func ndsInfo(path: String) -> [String: String] { kv(take(dslink_nds_info(path))) }
    static func validateSystemDir(_ dir: String) -> [String: String] { kv(take(dslink_validate_system_dir(dir))) }

    // host
    static func hostStart(advert: [String: String], nick: String, mac: String, port: Int, beacon: Bool) -> UnsafeMutableRawPointer? {
        dslink_host_start(encode(advert), nick, mac, Int32(port), beacon ? 1 : 0)
    }
    static func hostPeers(_ h: UnsafeMutableRawPointer) -> [String: String] { kv(take(dslink_host_peers(h))) }
    static func hostStop(_ h: UnsafeMutableRawPointer) { dslink_host_stop(h) }

    // client
    static func hello(ip: String, port: Int, info: [String: String], mac: String) -> [String: String] {
        kv(take(dslink_hello(ip, Int32(port), encode(info), mac)))
    }
    static func bye(ip: String, port: Int, deviceId: String) { dslink_bye(ip, Int32(port), deviceId) }
    static func probe(ip: String, port: Int, count: Int = 20) -> [String: String] {
        kv(take(dslink_probe(ip, Int32(port), Int32(count))))
    }

    // state machine
    static func smNew() -> UnsafeMutableRawPointer? { dslink_sm_new() }
    @discardableResult
    static func smEvent(_ h: UnsafeMutableRawPointer, _ event: String, _ info: String = "", remaining: Int = -1) -> Bool {
        dslink_sm_event(h, event, info, Int32(remaining)) != 0
    }
    static func smFree(_ h: UnsafeMutableRawPointer) { dslink_sm_free(h) }

    // launch plan -> RetroArch config
    static func launchConfig(_ plan: [String: String]) -> String { take(dslink_launch_config(encode(plan))) ?? "" }
    static func launchCoreOptions(_ plan: [String: String]) -> String { take(dslink_launch_core_options(encode(plan))) ?? "" }
    static func launchNetplayExtra(_ plan: [String: String]) -> String { take(dslink_launch_netplay_extra(encode(plan))) ?? "" }

    // logging / diagnostics
    static func log(_ line: String) { dslink_log(line) }
    static func diagnostics(_ report: [String: String]) -> String { take(dslink_diagnostics(encode(report))) ?? "" }
}

enum AppInfo {
    static let appVersion = "1.0.0"
    static let coreVersion = "melonDS DS 1.4.0"
    static let retroarchVersion = "RetroArch 1.22.2"
    static let protocolVersion = 1
    static let defaultPort = 55435
    static let serviceType = "_dslink._tcp"
}
