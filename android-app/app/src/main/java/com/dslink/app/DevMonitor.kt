package com.dslink.app

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.Process
import android.widget.TextView
import java.io.File

/** Developer overlay: FPS, frame time, CPU, RAM, audio, network quality, battery delta and thermal state. Off unless the developer menu turns it on. */
class DevMonitor(private val ctx: Context, private val tv: TextView) {
    private val h = Handler(Looper.getMainLooper())
    private var on = false
    private var pids = emptyMap<String, Int>()
    private var pidsAt = 0L
    private var lastWall = 0L
    private val lastTicks = HashMap<String, Long>()
    private var cpuApp = 0.0
    private var cpuRt = 0.0
    private var batteryStart = -1
    private val tick = object : Runnable { override fun run() { if (!on) return; update(); h.postDelayed(this, 1000) } }

    fun enable(v: Boolean) {
        on = v
        tv.visibility = if (v) android.view.View.VISIBLE else android.view.View.GONE
        h.removeCallbacks(tick)
        if (v) { batteryStart = batteryPct(); lastWall = 0; h.post(tick) }
    }

    private fun scan() {
        val m = HashMap<String, Int>()
        File("/proc").listFiles()?.forEach { f ->
            val pid = f.name.toIntOrNull() ?: return@forEach
            val cmd = try { File(f, "cmdline").readText() } catch (_: Exception) { return@forEach }
            if (cmd.contains("libdslink_runtime")) m["runtime"] = pid
            if (cmd.contains("libdslink_gateway")) m["gateway"] = pid
        }
        pids = m
    }

    private fun ticks(pid: Int): Long? = try { ProcStat.cpuTicks(File("/proc/$pid/stat").readText()) } catch (_: Exception) { null }

    private fun update() {
        val now = System.currentTimeMillis()
        if (now - pidsAt > 5000) { scan(); pidsAt = now }
        val wall = now - lastWall
        val me = Process.myPid()
        val set = mapOf("app" to me, "runtime" to (pids["runtime"] ?: -1), "gateway" to (pids["gateway"] ?: -1))
        for ((k, pid) in set) {
            val t = if (pid > 0) ticks(pid) else null
            if (t != null && lastTicks[k] != null && lastWall > 0 && wall > 0) {
                val pct = (t - lastTicks[k]!!) * 10.0 / wall * 100.0
                if (k == "app") cpuApp = pct else if (k == "runtime") cpuRt = pct
            }
            if (t != null) lastTicks[k] = t
        }
        lastWall = now
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val pss = am.getProcessMemoryInfo(intArrayOf(me)).firstOrNull()?.totalPss ?: 0
        val rtRss = pids["runtime"]?.let { try { ProcStat.rssKb(File("/proc/$it/status").readText()) } catch (_: Exception) { null } } ?: 0L
        val bp = batteryPct()
        val battery = "battery $bp%" + if (batteryStart >= 0) " (${bp - batteryStart} since start)" else ""
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        val thermal = if (android.os.Build.VERSION.SDK_INT >= 29) "thermal " + thermalName(pm.currentThermalStatus) else "thermal n/a"
        val net = netLine()
        tv.text = DevText.format(Native.nativeMetrics(), cpuApp, cpuRt, pss / 1024.0, rtRss / 1024.0, battery + " " + batteryTemp(), thermal, net)
    }

    private fun netLine(): String {
        val d = Gw.state(true)?.optJSONObject("dev")?.optJSONObject("net") ?: return "net: -"
        return "net RTT %.1f ms  jitter %.1f ms  loss %.1f%%  %s".format(d.optDouble("rttMs"), d.optDouble("jitterMs"), d.optDouble("lossPct"), d.optString("class"))
    }

    private fun batteryIntent(): Intent? = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    private fun batteryPct(): Int {
        val i = batteryIntent() ?: return -1
        val l = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1); val s = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        return if (l < 0) -1 else l * 100 / s
    }
    private fun batteryTemp(): String { val t = batteryIntent()?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1; return if (t < 0) "" else "%.1f°C".format(t / 10.0) }
    private fun thermalName(s: Int) = when (s) { 0 -> "none"; 1 -> "light"; 2 -> "moderate"; 3 -> "severe"; 4 -> "critical"; 5 -> "emergency"; 6 -> "shutdown"; else -> "?" }
}
