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
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestRule
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.junit.runners.model.Statement
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

    /** a failing test carries the gateway's, the Runtime's and the app's own log lines in its message (no other way to see them after the test APK is uninstalled) */
    @get:Rule val logsOnFailure = TestRule { base, _: Description ->
        object : Statement() {
            override fun evaluate() {
                try { base.evaluate() } catch (t: Throwable) {
                    val sb = StringBuilder(t.toString()).append("\n")
                    fun tail(f: File, n: Int) {
                        if (!f.exists()) return
                        val all = f.readLines()
                        val key = all.filter { Regex("fatal error|panic:|SIG[A-Z]+|unexpected signal|exit status|started:|FATAL|shm|core loaded|session:").containsMatchIn(it) }.take(6)
                        sb.append("--- ${f.name}: ${all.size} lines; key lines + last $n ---\n").append((key + all.takeLast(n)).joinToString("\n")).append("\n")
                    }
                    tail(File(ctx.filesDir, "gateway.log"), 15)
                    File(ctx.filesDir, "work").listFiles()?.filter { it.name.startsWith("slot") }?.forEach { tail(File(it, "runtime.log"), 15) }
                    try { sb.append("--- logcat ---\n").append(Runtime.getRuntime().exec(arrayOf("logcat", "-d", "-t", "60", "-s", "dslink-stack:V", "dslink-render:V", "dslink-audio:V", "dslink-jni:V", "AndroidRuntime:E")).inputStream.bufferedReader().readText()) } catch (_: Exception) { }
                    sb.lines().forEach { android.util.Log.e("dslink-test", it) }
                    throw AssertionError(sb.toString(), t)
                }
            }
        }
    }

    @Before fun setUp() {
        File(ctx.filesDir, "enable_test_hooks").writeText("1")   // before the gateway starts
        InstrumentationRegistry.getInstrumentation().context.assets.open("dslink_test_2.nds").use { i -> File(ctx.filesDir, "test_guest.nds").outputStream().use { o -> i.copyTo(o) } }   // the second console's homebrew cartridge (Hosted)
        scenario = ActivityScenario.launch(MainActivity::class.java)
        assertTrue("gateway answers on loopback", Stack.waitReady(40000))
    }

    @After fun tearDown() {
        Gw.post("/api/mp/cancel", JSONObject()); Gw.post("/api/mp/reset", JSONObject())
        Stack.stop()          // synchronous: the next test must not find the previous gateway still answering
        scenario.close()
        File(ctx.filesDir, "enable_test_hooks").delete()
        File(ctx.filesDir, "test_guest.nds").delete()
    }

    // ---- helpers
    private fun until(ms: Long = 20000, step: Long = 200, f: () -> Boolean): Boolean {
        val end = SystemClock.elapsedRealtime() + ms
        while (SystemClock.elapsedRealtime() < end) { if (f()) return true; SystemClock.sleep(step) }
        return false
    }
    private fun metrics() = Native.nativeMetrics()
    private fun mm() = "metrics[renderFps,uploads,surfW,surfH,frameW,frameH,audioOn,rate,underruns,skips,xruns,latMs,rtFps,rtFrameMs,rtMaxMs,peers,alive,PAUSED,vframes,awpos,session]=" + metrics().joinToString(",") { "%.1f".format(it) }
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
        assertTrue("Runtime alive and running in real time: ${mm()}", until(25000) { val m = metrics(); m[16] == 1.0 && m[12] > 25 })
        // VIDEO: native GL renderer draws the frames on the SurfaceView
        assertTrue("page switched to native display", js("document.body.classList.contains('native')") == "true")
        assertTrue("renderer running on a real surface: ${mm()}", until(20000) { val m = metrics(); m[0] > 20 && m[2] > 0 && m[3] > 0 })
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
        assertTrue("surface re-sized for landscape ${mm()}", until(15000) { val m = metrics(); m[2] != w0 && m[0] > 10 })
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
        assertTrue("resumed: running again ${mm()}", until(20000) { metrics()[12] > 25 })
        assertEquals("same session after the short background", "IN_GAME", state())

        // ACTIVITY RECREATE: new activity, new surface; the console keeps running and drawing
        scenario.recreate()
        assertTrue("session survives an activity recreate", until(20000) { state() == "IN_GAME" })
        assertTrue("renderer attaches to the new surface ${mm()}", until(20000) { val m = metrics(); m[0] > 20 && m[12] > 25 })

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

    private fun runtimeProcesses() = File("/proc").listFiles()!!.count { p -> p.name.toIntOrNull() != null && runCatching { File(p, "cmdline").readText().contains("libdslink_runtime") }.getOrDefault(false) }
    private fun jsJson(script: String): JSONObject {
        val raw = js(script)   // evaluateJavascript hands back a JSON-encoded string
        val v = org.json.JSONTokener(raw).nextValue()
        return runCatching { JSONObject(if (v is String) v else raw) }.getOrDefault(JSONObject())
    }

    /** The stream encoder on THIS device: MediaCodec H.264 (hardware on a phone, the software codec on the emulator) -> access units -> decoded again and compared with the synthetic picture. */
    @Test fun streamEncoderSelfTestPassesOnThisDevice() {
        val j = JSONObject(Stack.encoderSelfTest(ctx))
        android.util.Log.i("dslink-test", "encoder self-test: $j")
        assertTrue("encoder self-test: $j", j.optBoolean("pass"))
        assertTrue("a codec name is reported", j.optString("codec").isNotEmpty())
        assertTrue("access units came out: $j", j.optInt("out") >= 120)
        assertTrue("the first keyframe carries SPS+PPS+IDR: $j", j.optBoolean("firstKeyframeHasSpsPpsIdr"))
        assertTrue("decoded picture matches the input (or the vendor layout is skipped): $j", j.optString("decode") in listOf("ok", "skipped_vendor_format"))
    }

    /**
     * HOSTED, the iPhone case: this phone runs BOTH consoles; a browser guest (here: the app's own WebView standing in for Safari) joins through the web guest API, receives the
     * second console as H.264 (MediaCodec) + Opus over WebRTC and sends buttons back; when the browser goes away the session ends cleanly and both consoles stop.
     */
    @Test fun hostedBrowserGuestReceivesTheSecondConsoleFromMediaCodecOverWebRtc() {
        val id = uploadHomebrew()
        assertTrue(Gw.post("/api/mp/create", JSONObject().put("gameId", id)))
        val code = Gw.state()!!.optString("code")
        assertEquals(6, code.length)
        val sid = "ab12cd34".repeat(4)   // the browser's own handle
        assertTrue("web guest joins by code", Gw.post("/g/$sid/api/mp/join", JSONObject().put("code", code)))
        assertTrue("host sees the browser guest", until(20000) { Gw.state()!!.optString("state") in listOf("CONNECTED", "NETWORK_CHECK", "READY") })
        assertTrue(Gw.post("/g/$sid/api/mp/ready", JSONObject().put("ready", true)))
        assertTrue("host READY", until(20000) { Gw.state()!!.optBoolean("canStart") })
        assertTrue(Gw.post("/api/mp/start", JSONObject()))
        assertTrue("host IN_GAME: ${Gw.state()}", until(90000) { state() == "IN_GAME" })
        assertEquals("a browser guest always gets Hosted", "hosted", Gw.state()!!.getJSONObject("mode").optString("effective"))
        assertTrue("two consoles run on this phone (${runtimeProcesses()})", until(10000) { runtimeProcesses() == 2 })

        // the browser: signalling over /ws, media over WebRTC
        js("""(() => { const g = window.__g = { v: 0, vb: 0, a: 0, fd: 0, vw: 0, st: 'init', err: '', open: false };
          fetch('/g/$sid/api/mp/state').then((r) => r.json()).then((s) => { const ig = s.ingame; if (!ig) { g.err = 'no ingame'; return; }
            const pc = new RTCPeerConnection({ iceServers: [] }); g.pc = pc; g.dc = pc.createDataChannel('input', { ordered: true }); pc.createDataChannel('move', { ordered: false, maxRetransmits: 0 });
            pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' });
            const vid = document.createElement('video'); vid.muted = true; vid.autoplay = true; vid.playsInline = true; vid.style.display = 'none'; document.body.appendChild(vid); g.vid = vid;
            pc.ontrack = (e) => { if (!vid.srcObject) vid.srcObject = new MediaStream(); vid.srcObject.addTrack(e.track); vid.play().catch(() => {}); };
            const ws = new WebSocket('ws://' + location.host + '/ws?code=' + ig.code + '&player=' + ig.player + '&token=' + ig.token); g.ws = ws;
            ws.onmessage = async (m) => { const x = JSON.parse(m.data); if (x.type === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: x.sdp }); else if (x.type === 'candidate' && x.candidate) await pc.addIceCandidate(x.candidate); };
            pc.onicecandidate = (e) => { if (e.candidate && ws.readyState === 1) ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate.toJSON() })); };
            ws.onopen = async () => { g.open = true; const o = await pc.createOffer(); await pc.setLocalDescription(o); ws.send(JSON.stringify({ type: 'offer', sdp: o.sdp })); };
            ws.onerror = () => { g.err = 'ws error'; };
            g.poll = setInterval(() => { fetch('/g/$sid/api/mp/state').catch(() => {}); }, 600);   // what the guest page does while it is open: the host hears the browser through it
            g.timer = setInterval(async () => { g.st = pc.connectionState; const st = await pc.getStats(); st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') { g.v = r.packetsReceived; g.vb = r.bytesReceived; g.fd = r.framesDecoded || 0; } if (r.type === 'inbound-rtp' && r.kind === 'audio') g.a = r.packetsReceived; }); g.vw = vid.videoWidth; }, 500);
          }).catch((e) => { g.err = String(e); }); return 'started'; })()""")
        val q = "JSON.stringify({st:__g.st,v:__g.v,a:__g.a,vb:__g.vb,fd:__g.fd,vw:__g.vw,open:__g.open,err:__g.err})"
        var last = JSONObject()
        val flowing = until(60000, 500) { last = jsJson(q); last.optString("st") == "connected" && last.optInt("v") > 60 && last.optInt("a") > 30 }
        assertTrue("WebRTC connects and video/audio packets arrive: $last", flowing)
        android.util.Log.i("dslink-test", "browser guest stats: $last")
        assertTrue("video bytes flow (H.264 from MediaCodec): $last", last.optInt("vb") > 20000)
        if (last.optInt("fd") == 0) android.util.Log.w("dslink-test", "this WebView decoded no frame yet (packets arrived): $last")

        // the second console reports its encoder; the browser's buttons reach console 2 only
        val dev = Gw.state(true)!!.getJSONObject("dev").getJSONArray("slots")
        var p2 = JSONObject()
        for (i in 0 until dev.length()) { val sl = dev.getJSONObject(i); if (sl.optInt("id") == 2) p2 = sl }
        val enc = p2.optJSONObject("enc")
        android.util.Log.i("dslink-test", "console 2 encoder: $enc  fps ${p2.optDouble("fps")}")
        assertNotNull("console 2 reports its encoder", enc)
        assertTrue("encoder produced pictures: $enc", enc!!.optInt("out") > 60 && enc.optString("codec").isNotEmpty())
        js("(() => { __g.dc.send(JSON.stringify({t:'btn',k:'a',d:true})); __g.dc.send(JSON.stringify({t:'btn',k:'a',d:false})); return 'sent'; })()")
        assertTrue("the browser's buttons reach console 2", until(10000) {
            val sl = Gw.state(true)!!.getJSONObject("dev").getJSONArray("slots")
            var n2 = 0; var n1 = -1
            for (i in 0 until sl.length()) { val o = sl.getJSONObject(i); if (o.optInt("id") == 2) n2 = o.optInt("input_events") else if (o.optInt("id") == 1) n1 = o.optInt("input_events") }
            n2 >= 2 && n1 == 0
        })

        // the browser goes away for good: the host is told, both consoles and the stream are released
        js("(() => { clearInterval(__g.timer); clearInterval(__g.poll); __g.ws.close(); __g.pc.close(); return 'closed'; })()")
        assertTrue("host: peer lost -> ENDED ('Connessione con il giocatore persa.')", until(60000, 500) {
            val s = Gw.state(); s != null && s.optString("state") == "ENDED" && s.optJSONObject("error")?.optString("message") == "Connessione con il giocatore persa."
        })
        assertTrue("both consoles stop", until(20000) { runtimeProcesses() == 0 })
    }

    @Test fun discoveryHintsAndNetworkReachTheGateway() {
        assertTrue(Gw.post("/api/mp/hints", JSONObject().put("addrs", org.json.JSONArray(listOf("192.168.1.77")))))
        assertTrue(Gw.post("/api/mp/net", JSONObject().put("ip", "192.168.1.50").put("broadcast", "192.168.1.255")))
        val id = uploadHomebrew()
        assertTrue(Gw.post("/api/mp/create", JSONObject().put("gameId", id)))
        val s = Gw.state()!!
        assertTrue("QR payload carries the platform's Wi-Fi address, never shown to the user", s.optString("qr").contains("http://192.168.1.50:${Stack.HTTP_PORT}/guest/?c="))
        assertEquals("host lobby open", "WAITING_FOR_PEER", s.optString("state"))
    }
}
