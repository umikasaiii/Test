package com.dslink.app

// Pure logic (no Android API): unit-tested on the JVM in CI.

/** CPU time of a process from /proc/<pid>/stat: utime + stime in clock ticks (fields 14 and 15; the command name in field 2 may contain spaces). */
object ProcStat {
    fun cpuTicks(line: String): Long? {
        val close = line.lastIndexOf(')')
        if (close < 0) return null
        val f = line.substring(close + 1).trim().split(' ')   // f[0] is field 3 (state)
        if (f.size < 13) return null
        val ut = f[11].toLongOrNull() ?: return null
        val st = f[12].toLongOrNull() ?: return null
        return ut + st
    }

    /** resident set size in KiB from /proc/<pid>/status ("VmRSS:   12345 kB") */
    fun rssKb(status: String): Long? =
        status.lineSequence().firstOrNull { it.startsWith("VmRSS:") }?.split(Regex("\\s+"))?.getOrNull(1)?.toLongOrNull()
}

object NetMath {
    /** directed broadcast address of ip/prefix, e.g. 192.168.1.50/24 -> 192.168.1.255 */
    fun broadcast(ip: String, prefix: Int): String? {
        val p = ip.split('.').mapNotNull { it.toIntOrNull() }
        if (p.size != 4 || p.any { it !in 0..255 } || prefix !in 1..30) return null
        val addr = (p[0].toLong() shl 24) or (p[1].toLong() shl 16) or (p[2].toLong() shl 8) or p[3].toLong()
        val mask = (0xFFFFFFFFL shl (32 - prefix)) and 0xFFFFFFFFL
        val b = (addr and mask) or (mask.inv() and 0xFFFFFFFFL)
        return "${(b shr 24) and 255}.${(b shr 16) and 255}.${(b shr 8) and 255}.${b and 255}"
    }

    /** private LAN addresses only (RFC 1918 + link-local): what a phone on Wi-Fi has; never advertise anything else */
    fun isLan(ip: String): Boolean {
        val p = ip.split('.').mapNotNull { it.toIntOrNull() }
        if (p.size != 4) return false
        return p[0] == 10 || (p[0] == 172 && p[1] in 16..31) || (p[0] == 192 && p[1] == 168) || (p[0] == 169 && p[1] == 254)
    }
}

/** the user-facing words for the network: no RTT in the normal UI */
object Words {
    fun deviceName(model: String?): String {
        val m = (model ?: "").trim().replace(Regex("[^A-Za-z0-9 _-]"), "").take(18).trim()
        return if (m.isEmpty()) "Telefono" else m
    }
}

/** the developer overlay text (only shown from the developer menu) */
object DevText {
    /** Hosted: the second console that is streamed to another device (an iPhone) and the encoder that feeds it. */
    data class Hosted(val player: Int, val p2Fps: Double, val codec: String, val hardware: Boolean, val encFps: Double, val latMs: Double, val latMaxMs: Double, val kbps: Double, val dropped: Long, val rttMs: Double, val connected: Boolean)

    /** one block per streamed console (P2, and P3 when a second guest plays) */
    fun hosted(hs: List<Hosted>): List<String> = hs.flatMap { h ->
        val codec = if (h.codec.isEmpty()) "no encoder" else "${h.codec} (${if (h.hardware) "hardware" else "software"})"
        listOf(
            "P${h.player} emu %.1f fps  guest %s  RTT %s".format(h.p2Fps, if (h.connected) "connected" else "not connected", if (h.rttMs > 0) "%.1f ms".format(h.rttMs) else "-"),
            "encoder P${h.player}: $codec  %.1f fps  latency %.1f ms (max %.1f)  %.0f kbps  dropped %d".format(h.encFps, h.latMs, h.latMaxMs, h.kbps, h.dropped),
        )
    }

    fun format(m: DoubleArray, cpuApp: Double, cpuRuntime: Double, ramAppMb: Double, ramRuntimeMb: Double, battery: String, thermal: String, net: String, hosted: List<Hosted> = emptyList()): String {
        fun d(i: Int) = if (i < m.size) m[i] else 0.0
        val lines = ArrayList<String>()
        lines += "FPS P1 emu %.1f  render %.1f  frame %.1f ms (max %.1f)".format(d(12), d(0), d(13), d(14))
        lines += hosted(hosted)
        lines += "frame %dx%d  surface %dx%d".format(d(4).toInt(), d(5).toInt(), d(2).toInt(), d(3).toInt())
        lines += "CPU app %.0f%%  runtime %.0f%%   RAM %.0f + %.0f MB".format(cpuApp, cpuRuntime, ramAppMb, ramRuntimeMb)
        lines += "audio %s %d Hz  underrun %d  xrun %d  skip %d  lat %.0f ms".format(if (d(6) > 0) "on" else "off", d(7).toInt(), d(8).toLong(), d(10).toLong(), d(9).toLong(), d(11))
        lines += net
        lines += "$battery  $thermal"
        return lines.joinToString("\n")
    }
}
