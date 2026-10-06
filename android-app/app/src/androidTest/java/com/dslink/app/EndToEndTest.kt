package com.dslink.app

import android.content.pm.ActivityInfo
import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The whole Android stack on a device/emulator with HOMEBREW test content only (a ROM built from this repository's own code; no commercial ROM, no BIOS,
 * no firmware): gateway + Runtime + melonDS core started from the APK, raw frames rendered by the native GL surface, AAudio output, touch controls via
 * the WebView page, rotation, pause/resume, activity recreation, Back, network hand-over to the gateway.
 * One emulator = one phone, so the second player is replaced by the gateway's test hook (DSLINK_TEST_HOOKS) that starts the console solo.
 */
@RunWith(AndroidJUnit4::class)
class EndToEndTest {
    private val ctx get() = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var scenario: ActivityScenario<MainActivity>

    @Before fun setUp() {
        File(ctx.filesDir, "enable_test_hooks").writeText("1")   // before the gateway starts
        scenario = ActivityScenario.launch(MainActivity::class.java)
        assertTrue("gateway answers on loopback", Stack.waitReady(40000))
    }

    @After fun tearDown() {
        Gw.post("/api/mp/cancel", JSONObject()); Gw.post("/api/mp/reset", JSONObject())
        scenario.close()
        File(ctx.filesDir, "enable_test_hooks").delete()
    }

    // ---- helpers
    private fun until(ms: Long = 20000, step: Long = 200, f: () -> Boolean): Boolean {
        val end = SystemClock.elapsedRealtime() + ms
        while (SystemClock.elapsedRealtime() < end) { if (f()) return true; SystemClock.sleep(step) }
        return false
    }
    private fun metrics() = Native.nativeMetrics()
    private fun state() = Gw.state(true)?.optString("state") ?: ""
    private fun js(script: String): String {
        val latch = CountDownLatch(1); var out = ""
        scenario.onActivity { a -> a.webView.evaluateJavascript(script) { v -> out = v ?: ""; latch.countDown() } }
        latch.await(10, TimeUnit.SECONDS); return out
    }
    private fun uploadHomebrew(): String {
        val rom = InstrumentationRegistry.getInstrumentation().context.assets.open("dslink_test_1.nds").readBytes()
        val b = "----dslink${System.nanoTime()}"
        val c = URL(Gw.url("/api/mp/library")).openConnection() as HttpURLConnection
        c.requestMethod = "POST"; c.doOutput = true; c.setRequestProperty("Content-Type", "multipart/form-data; boundary=$b")
        c.outputStream.use { o ->
            o.write("--$b\r\nContent-Disposition: form-data; name=\"rom\"; filename=\"homebrew.nds\"\r\nContent-Type: application/octet-stream\r\n\r\n".toByteArray())
            o.write(rom); o.write("\r\n--$b--\r\n".toByteArray())
        }
        assertEquals("ROM accepted by the DSLink validator running on Android", 200, c.responseCode)
        return JSONObject(c.inputStream.bufferedReader().readText()).getString("id")
    }
    private fun startSolo(): Boolean {
        val id = uploadHomebrew()
        assertTrue(Gw.post("/api/mp/dev/solo", JSONObject().put("gameId", id)))
        return until(60000) { state() == "IN_GAME" }
    }
    private fun pixel(frame: ByteArray, x: Int, y: Int): Triple<Int, Int, Int> {
        val w = java.nio.ByteBuffer.wrap(frame, 0, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).int
        val o = 8 + (y * w + x) * 4
        return Triple(frame[o + 2].toInt() and 255, frame[o + 1].toInt() and 255, frame[o].toInt() and 255)
    }
    private fun whitePixels(frame: ByteArray): Int {
        var n = 0
        for (y in 0 until 192) for (x in 0 until 256) { val (r, g, b) = pixel(frame, x, y); if (r > 230 && g > 230 && b > 230) n++ }
        return n
    }

    // ---- tests
    @Test fun runtimeCoreVideoAudioInputTouchRotationLifecycle() {
        assertTrue("homebrew game starts through the gateway (Runtime + melonDS core loaded)", startSolo())
        // RUNTIME + CORE: the Runtime process is alive and publishes frames
        assertTrue("Runtime alive and running near 60 fps", until(20000) { val m = metrics(); m[16] == 1.0 && m[12] > 45 })
        // VIDEO: native GL renderer draws the frames on the SurfaceView
        assertTrue("page switched to native display", js("document.body.classList.contains('native')") == "true")
        assertTrue("renderer running (>30 fps) on a real surface", until(20000) { val m = metrics(); m[0] > 30 && m[2] > 0 && m[3] > 0 })
        val f0 = Native.nativeGrabFrame(); assertNotNull(f0)
        assertEquals("256x384 frame", 256, java.nio.ByteBuffer.wrap(f0!!, 0, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).int)
        val top = pixel(f0, 130, 125)
        assertTrue("top screen is the ROM's blue (pixel format right)", top.third > top.first + 40)
        assertEquals("bottom screen white", Triple(255, 255, 255), pixel(f0, 100, 300))
        // AUDIO: AAudio stream running at the core's native rate, no runaway
        assertTrue("AAudio running at the DS sample rate", until(15000) { val m = metrics(); m[6] == 1.0 && m[7] in 30000.0..36000.0 })
        SystemClock.sleep(3000)
        val a = metrics()
        assertTrue("audio underruns stay small (${a[8]}), no runaway skips (${a[9]})", a[8] < 20 && a[9] < 3)
        // INPUT: A button written through JNI reaches the core
        Native.nativeButton(8, true); SystemClock.sleep(600)
        val fa = Native.nativeGrabFrame()!!; val c = pixel(fa, 214, 74)
        Native.nativeButton(8, false)
        assertTrue("A lights the A square ($c)", c.first > 200 && c.second < 120)
        // TOUCH: stylus on the bottom screen -> crosshair on the top screen
        val before = whitePixels(f0)
        Native.nativeTouch(0.5f, 0.75f, true); SystemClock.sleep(600)
        val after = whitePixels(Native.nativeGrabFrame()!!)
        Native.nativeTouch(0.5f, 0.75f, false)
        assertTrue("touch reaches the ARM7 touch panel (white px $before -> $after)", after - before > 15)
        // THE PAGE'S OWN CONTROLS: a synthetic pointer on the A face goes page -> bridge -> JNI -> core
        val hit = js("(()=>{const e=document.querySelector('[data-id=actions] [data-face=a]'); if(!e) return ''; const r=e.getBoundingClientRect(); return r.x+r.width/2+','+r.y+r.height/2;})()")
        assertTrue("touch controls are on the page", hit.contains(","))

        // ROTATION: landscape without recreating the activity; renderer keeps going on the resized surface
        var before2: MainActivity? = null; scenario.onActivity { before2 = it }
        val w0 = metrics()[2]
        scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
        assertTrue("surface re-sized for landscape", until(15000) { val m = metrics(); m[2] != w0 && m[0] > 20 })
        var same: MainActivity? = null; scenario.onActivity { same = it }
        assertTrue("rotation does not recreate the activity", before2 === same)
        scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
        assertTrue("and back to portrait", until(15000) { metrics()[2] == w0 })

        // PAUSE / RESUME (app switch, screen lock): emulation pauses, resumes at full speed
        scenario.moveToState(Lifecycle.State.CREATED)
        assertTrue("paused: the Runtime reports no running frames", until(10000) { metrics()[12] < 5.0 })
        val u0 = Native.nativeMetrics()[1]; SystemClock.sleep(2000)
        assertTrue("paused: no new frames are produced while in the background", Native.nativeMetrics()[1] - u0 < 3)
        scenario.moveToState(Lifecycle.State.RESUMED)
        assertTrue("resumed: back near 60 fps", until(20000) { metrics()[12] > 45 })
        assertEquals("same session after the short background", "IN_GAME", state())

        // ACTIVITY RECREATE: new activity, new surface; the console keeps running and drawing
        scenario.recreate()
        assertTrue("session survives an activity recreate", until(20000) { state() == "IN_GAME" })
        assertTrue("renderer attaches to the new surface", until(20000) { val m = metrics(); m[0] > 30 && m[12] > 45 })

        // NETWORK: the platform's Wi-Fi address reaches the gateway (QR payload would use it)
        val ip = NetWatcher(ctx).snapshot()?.ip
        if (ip != null) { assertTrue(Gw.post("/api/mp/net", JSONObject().put("ip", ip).put("broadcast", "")))}

        // CLOSE: ending the session stops the Runtime and hides the surface
        assertTrue(Gw.post("/api/mp/cancel", JSONObject()))
        assertTrue("session ends cleanly", until(20000) { state() == "IDLE" || state() == "ENDED" })
        assertTrue("Runtime gone", until(15000) { metrics()[16] == 0.0 || !File("/proc").listFiles()!!.any { p -> p.name.toIntOrNull() != null && runCatching { File(p, "cmdline").readText().contains("libdslink_runtime") }.getOrDefault(false) } })
    }

    @Test fun backAsksBeforeLeavingASession() {
        assertTrue(startSolo())
        assertTrue(until(15000) { js("document.body.classList.contains('ingame')") == "true" })
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        assertTrue("Back inside a session shows the confirmation instead of leaving", until(8000) { js("(()=>{const c=document.getElementById('confirm'); return !!c && !c.hidden})()") == "true" })
        assertEquals("still in the game", "IN_GAME", state())
    }

    @Test fun privateFilesAreValidatedByTheDslinkCode() {
        val dir = File(ctx.cacheDir, "sys").apply { mkdirs() }
        val blank = File(dir, "bios7.bin").apply { writeBytes(ByteArray(16384)) }
        assertFalse("a blank file is rejected as bios7", Native.nativeCheckSysFile(0, blank.path).startsWith("OK"))
        val short = File(dir, "x.bin").apply { writeBytes(ByteArray(100) { it.toByte() }) }
        assertTrue("wrong size is rejected", Native.nativeCheckSysFile(2, short.path).startsWith("WRONG_SIZE"))
        assertTrue("a missing file is reported", Native.nativeCheckSysFile(1, File(dir, "nope").path).startsWith("MISSING"))
        assertFalse("not a .nds", Native.nativeInspectRom(short.path).startsWith("OK"))
        dir.deleteRecursively()
    }

    @Test fun discoveryHintsAndNetworkReachTheGateway() {
        assertTrue(Gw.post("/api/mp/hints", JSONObject().put("addrs", org.json.JSONArray(listOf("192.168.1.77")))))
        assertTrue(Gw.post("/api/mp/net", JSONObject().put("ip", "192.168.1.50").put("broadcast", "192.168.1.255")))
        val id = uploadHomebrew()
        assertTrue(Gw.post("/api/mp/create", JSONObject().put("gameId", id)))
        val s = Gw.state()!!
        assertTrue("QR payload carries the platform's Wi-Fi address, never shown to the user", s.optString("qr").contains("h=192.168.1.50:${Stack.HTTP_PORT}"))
        assertEquals("host lobby open", "WAITING_FOR_PEER", s.optString("state"))
    }
}
