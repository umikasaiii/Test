package com.dslink.app

import android.content.Context
import android.os.Build
import android.util.Log
import java.io.File

/**
 * The native stack that lives next to the UI: the DSLink gateway (Go: lobby, session state machine, LAN discovery, Download Play assistant) which in turn
 * starts ONE DSLink Runtime (C++/melonDS) per game. All of it ships inside the APK as lib*.so executables and runs from nativeLibraryDir.
 * The private files (ROMs, BIOS, firmware) only ever live in this app's private storage (filesDir).
 */
object Stack {
    const val HTTP_PORT = 8765
    private const val TAG = "dslink-stack"
    private var proc: Process? = null

    fun filesRoot(ctx: Context) = ctx.filesDir
    fun shmPath(ctx: Context) = File(ctx.filesDir, "av.shm").path
    fun systemDir(ctx: Context) = File(ctx.filesDir, "system")

    @Synchronized
    fun running(): Boolean = proc?.isAlive == true

    /** Copies the web UI + the frozen touch controls from the APK assets (once per installed build) and starts the gateway. Idempotent. */
    @Synchronized
    fun ensureStarted(ctx: Context, wifi: NetSnapshot?): Boolean {
        if (proc?.isAlive == true) return true
        val root = filesRoot(ctx)
        val web = File(root, "webroot")
        val stamp = "${Build.VERSION.SDK_INT}-${ctx.packageManager.getPackageInfo(ctx.packageName, 0).lastUpdateTime}"
        val marker = File(web, ".stamp")
        if (!marker.exists() || marker.readText() != stamp) {
            web.deleteRecursively()
            copyAssets(ctx, "web", File(web, "web"))
            copyAssets(ctx, "controls", File(web, "controls"))
            marker.writeText(stamp)
        }
        val lib = File(ctx.applicationInfo.nativeLibraryDir)
        val gateway = File(lib, "libdslink_gateway.so")
        if (!gateway.canExecute()) { Log.e(TAG, "gateway binary missing or not executable: $gateway"); return false }
        File(root, "work").mkdirs(); File(root, "library").mkdirs(); systemDir(ctx).mkdirs()
        val pb = ProcessBuilder(gateway.path, "-addr", ":$HTTP_PORT", "-web", File(web, "web").path, "-controls", File(web, "controls").path)
        pb.directory(root)
        pb.redirectErrorStream(true)
        pb.redirectOutput(File(root, "gateway.log"))
        pb.environment().apply {
            put("HOME", root.path); put("TMPDIR", ctx.cacheDir.path)
            put("DSLINK_BACKEND", "runtime")
            put("DSLINK_RUNTIME", File(lib, "libdslink_runtime.so").path)
            put("DSLINK_CORE", File(lib, "libmelondsds_libretro.so").path)
            put("DSLINK_CFGTOOL", File(lib, "libdslink_cfgtool.so").path)
            put("DSLINK_ROMCHECK", File(lib, "libdslink_romcheck.so").path)
            put("DSLINK_WORKDIR", File(root, "work").path)
            put("DSLINK_LIBRARY", File(root, "library").path)
            put("DSLINK_FIRMWARE_DIR", systemDir(ctx).path)
            put("DSLINK_SHM_PATH", shmPath(ctx))
            put("DSLINK_NO_ENCODER", "1")            // no H.264/Opus encoder in the app: Hosted *host* is not available yet, Distributed is
            put("DSLINK_UI_LOOPBACK_ONLY", "1")      // other phones may only reach the peer lobby protocol
            put("DSLINK_PARENT_PID", android.os.Process.myPid().toString())   // never outlive the app
            put("DSLINK_DEVICE_NAME", Words.deviceName(Build.MODEL))
            if (File(root, "enable_test_hooks").exists()) put("DSLINK_TEST_HOOKS", "1")   // instrumented tests only (the marker is created by the test)
            wifi?.let { put("DSLINK_ADVERTISE_IP", it.ip); it.broadcast?.let { b -> put("DSLINK_MP_DISCOVERY_ADDR", b) } }
        }
        proc = try { pb.start() } catch (e: Exception) { Log.e(TAG, "gateway start failed", e); null }
        return proc != null
    }

    /** waits until the gateway answers on loopback */
    fun waitReady(timeoutMs: Long = 20000): Boolean {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (Gw.get("/api/mp/state") != null) return true
            if (proc?.isAlive == false) return false
            Thread.sleep(100)
        }
        return false
    }

    @Synchronized
    fun stop() {
        val p = proc ?: return
        proc = null
        p.destroy()   // SIGTERM: the gateway closes its room (stops the Runtime process groups)
        try { if (!p.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly() } catch (_: InterruptedException) { p.destroyForcibly() }
    }

    private fun copyAssets(ctx: Context, from: String, to: File) {
        val list = ctx.assets.list(from) ?: return
        if (list.isEmpty()) {   // a file
            to.parentFile?.mkdirs()
            ctx.assets.open(from).use { i -> to.outputStream().use { o -> i.copyTo(o) } }
            return
        }
        to.mkdirs()
        for (n in list) copyAssets(ctx, "$from/$n", File(to, n))
    }
}
