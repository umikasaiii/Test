import XCTest
@testable import DSLink

final class NativeTests: XCTestCase {
    func testKvRoundTrip() {
        let m = ["a": "1", "room": "Stanza di Simone"]
        XCTAssertEqual(Native.kv(Native.encode(m)), m)
    }

    func testIdentityIsCreatedAndPersisted() throws {
        let path = NSTemporaryDirectory() + "dslink-test-id-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: path) }
        let a = Native.identity(path: path)
        XCTAssertEqual(a["created"], "1")
        XCTAssertEqual(a["device_id"]?.count, 32)
        let b = Native.identity(path: path)
        XCTAssertEqual(b["created"], "0")
        XCTAssertEqual(a["device_id"], b["device_id"])
        XCTAssertEqual(a["mac"], b["mac"])
    }

    func testSystemFileDetectionAndValidation() {
        XCTAssertEqual(Names.systemFileName(forSize: 16384), "bios7.bin")
        XCTAssertEqual(Names.systemFileName(forSize: 4096), "bios9.bin")
        XCTAssertEqual(Names.systemFileName(forSize: 262144), "firmware.bin")
        XCTAssertNil(Names.systemFileName(forSize: 7))
        XCTAssertTrue(Names.isValidIPv4("192.168.1.20"))
        XCTAssertFalse(Names.isValidIPv4("256.1.1.1"))
        XCTAssertFalse(Names.isValidIPv4("01.2.3.4"))
        XCTAssertTrue(Names.isValidPort(55435))
        XCTAssertFalse(Names.isValidPort(80))
    }

    func testHostAcceptsClientOverLoopback() {
        let advert = ["proto": "1", "app": "1.0.0", "core": "c", "room": "R", "ip": "127.0.0.1", "port": "55435",
                      "game": "G", "session": "s1", "host": String(repeating: "a", count: 32),
                      "mode": "download-play", "console": "nds", "players": "1", "max": "4"]
        let port = Native.pickPort(50000)
        XCTAssertGreaterThan(port, 0)
        let h = Native.hostStart(advert: advert, nick: "Host", mac: "00:08:BF:11:11:11", port: port, beacon: false)
        XCTAssertNotNil(h)
        let res = Native.hello(ip: "127.0.0.1", port: port,
                               info: ["proto": "1", "app": "1.0.0", "core": "c", "console": "nds", "mode": "download-play",
                                      "device": String(repeating: "b", count: 32), "nick": "Nick"],
                               mac: "00:08:BF:22:22:22")
        XCTAssertEqual(res["ok"], "1")
        let bad = Native.hello(ip: "127.0.0.1", port: port,
                               info: ["proto": "9", "app": "1.0.0", "core": "c", "console": "nds", "mode": "download-play",
                                      "device": String(repeating: "c", count: 32), "nick": "Nick2"],
                               mac: "00:08:BF:33:33:33")
        XCTAssertEqual(bad["code"], "PROTO_MISMATCH")
        if let h = h { Native.hostStop(h) }
    }
}
