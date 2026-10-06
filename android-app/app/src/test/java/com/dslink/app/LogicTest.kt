package com.dslink.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LogicTest {
    @Test fun procStatHandlesSpacesInTheCommandName() {
        val line = "1234 (dslink runtime) S 1 1234 1234 0 -1 4194304 100 0 0 0 250 150 0 0 20 0 5 0 1000 2000000 500 18446744073709551615"
        assertEquals(400L, ProcStat.cpuTicks(line))
        assertNull(ProcStat.cpuTicks("garbage"))
    }

    @Test fun rssFromStatus() {
        assertEquals(123456L, ProcStat.rssKb("Name:\tx\nVmRSS:\t  123456 kB\nThreads:\t4"))
        assertNull(ProcStat.rssKb("Name:\tx"))
    }

    @Test fun broadcastAddress() {
        assertEquals("192.168.1.255", NetMath.broadcast("192.168.1.50", 24))
        assertEquals("192.168.7.255", NetMath.broadcast("192.168.5.9", 22))
        assertEquals("10.255.255.255", NetMath.broadcast("10.1.2.3", 8))
        assertNull(NetMath.broadcast("300.1.1.1", 24))
        assertNull(NetMath.broadcast("192.168.1.1", 32))
    }

    @Test fun onlyPrivateLanAddressesAreAdvertised() {
        assertTrue(NetMath.isLan("192.168.1.9")); assertTrue(NetMath.isLan("10.0.0.2")); assertTrue(NetMath.isLan("172.20.1.1")); assertTrue(NetMath.isLan("169.254.3.4"))
        assertFalse(NetMath.isLan("8.8.8.8")); assertFalse(NetMath.isLan("172.32.0.1")); assertFalse(NetMath.isLan("127.0.0.1")); assertFalse(NetMath.isLan("abc"))
    }

    @Test fun deviceNameIsShortAndClean() {
        assertEquals("Pixel 8", Words.deviceName("Pixel 8"))
        assertEquals("Telefono", Words.deviceName("  "))
        assertEquals("Telefono", Words.deviceName(null))
        assertEquals("SM-G991B", Words.deviceName("SM-G991B"))
        assertTrue(Words.deviceName("A very long device model name here").length <= 18)
    }

    @Test fun devOverlayTextNamesEveryMetric() {
        val m = DoubleArray(17) { 0.0 }; m[0] = 59.9; m[12] = 60.0; m[13] = 3.2; m[14] = 8.0; m[6] = 1.0; m[7] = 32728.0; m[8] = 2.0
        val t = DevText.format(m, 31.0, 55.0, 120.0, 210.0, "battery 80% (-1)", "thermal none", "RTT 0.4 ms")
        for (w in listOf("FPS", "CPU", "RAM", "audio", "underrun", "RTT", "battery", "thermal")) assertTrue("missing $w", t.contains(w))
    }

    @Test fun hostedOverlayShowsTheSecondConsoleAndTheEncoder() {
        val m = DoubleArray(17) { 0.0 }
        val h2 = DevText.Hosted(2, 59.7, "c2.qti.avc.encoder", true, 59.2, 7.4, 16.0, 2310.0, 3, 3.1, true)
        val h3 = DevText.Hosted(3, 58.9, "c2.qti.avc.encoder", true, 58.1, 8.0, 17.0, 2290.0, 5, 4.2, true)
        val t = DevText.format(m, 30.0, 90.0, 100.0, 300.0, "battery 80%", "thermal none", "net", listOf(h2, h3))
        for (w in listOf("P2 emu 59.7", "P3 emu 58.9", "connected", "RTT 3.1 ms", "RTT 4.2 ms", "encoder P2: c2.qti.avc.encoder (hardware)", "encoder P3", "59.2 fps", "58.1 fps", "latency 7.4", "2310 kbps", "dropped 3", "dropped 5")) assertTrue("missing $w in\n$t", t.contains(w))
        assertTrue(DevText.format(m, 0.0, 0.0, 0.0, 0.0, "", "", "").lines().none { it.startsWith("P2") || it.startsWith("P3") })
        assertTrue(DevText.hosted(listOf(DevText.Hosted(2, 0.0, "", false, 0.0, 0.0, 0.0, 0.0, 0, 0.0, false))).any { it.contains("no encoder") })
    }

    @Test fun refsFileShapeIsChecked() {
        val h = "01".repeat(96)
        fun one() = """{"top":"$h","bot":"$h"}"""
        val ok = listOf("host_main_menu", "host_find_players", "client_ds_menu", "client_dl_open", "client_discovered").joinToString(",", "{", "}") { "\"$it\":${one()}" }
        assertNull(RefsCheck.validate(ok))
        assertNotNull(RefsCheck.validate("not json"))
        assertNotNull(RefsCheck.validate("{}"))
        assertNotNull(RefsCheck.validate(ok.replace(h, "01")))
    }
}
