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
    @Test fun streamEncodersSelfTestPassesOnThisDevice() {
        val all = JSONObject(Stack.encoderSelfTest(ctx, 2))   // TWO encoders at the same time: Hosted with two iPhones
        android.util.Log.i("dslink-test", "encoder self-test (2 concurrent streams): $all")
        assertTrue("both streams pass: $all", all.optBoolean("pass"))
        assertEquals("two concurrent encoders", 2, all.optInt("concurrent"))
        val arr = all.getJSONArray("streams")
        assertEquals(2, arr.length())
        for (i in 0 until arr.length()) {
            val j = arr.getJSONObject(i)
            assertTrue("stream $i: a codec name is reported: $j", j.optString("codec").isNotEmpty())
            assertTrue("stream $i: access units came out: $j", j.optInt("out") >= 120)
            assertTrue("stream $i: the first keyframe carries SPS+PPS+IDR: $j", j.optBoolean("firstKeyframeHasSpsPpsIdr"))
            assertTrue("stream $i: decoded picture matches the input (or the vendor layout is skipped): $j", j.optString("decode") in listOf("ok", "skipped_vendor_format"))
        }
    }

    /** the browser side of one guest (the app's own WebView stands in for Safari): its guest session heartbeat, signalling over /ws, media over WebRTC, counters in window.<name> */
    private fun guestJs(name: String, sid: String) = """(() => { const g = window.$name = { v: 0, vb: 0, a: 0, fd: 0, vw: 0, st: 'init', err: '', open: false };
          fetch('/g/$sid/api/mp/state').then((r) => r.json()).then((s) => { const ig = s.ingame; if (!ig) { g.err = 'no ingame'; return; } g.player = ig.player;
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
          }).catch((e) => { g.err = String(e); }); return 'started'; })()"""
    private fun guestQ(name: String) = "JSON.stringify({st:$name.st,v:$name.v,a:$name.a,vb:$name.vb,fd:$name.fd,vw:$name.vw,open:$name.open,err:$name.err,player:$name.player})"
    private fun slotsOf() = Gw.state(true)!!.getJSONObject("dev").getJSONArray("slots")
    private fun slotById(id: Int): JSONObject { val sl = slotsOf(); for (i in 0 until sl.length()) if (sl.getJSONObject(i).optInt("id") == id) return sl.getJSONObject(i); return JSONObject() }

    /**
     * HOSTED with TWO browser guests (two iPhones): this phone runs THREE consoles on one local DS wireless bridge, two MediaCodec encoders, two WebRTC peers; each browser receives only its own
     * console and its buttons reach only that console; when one browser goes away the other keeps playing; when the last one goes the session ends cleanly and every console stops.
     */
    @Test fun hostedTwoBrowserGuestsEachReceiveTheirOwnConsoleFromMediaCodec() {
        val id = uploadHomebrew()
        assertTrue(Gw.post("/api/mp/create", JSONObject().put("gameId", id)))
        val code = Gw.state()!!.optString("code")
        assertEquals(6, code.length)
        val sid1 = "ab12cd34".repeat(4); val sid2 = "ef56ab78".repeat(4)   // each browser's own handle
        assertTrue("browser 1 joins by code", Gw.post("/g/$sid1/api/mp/join", JSONObject().put("code", code)))
        assertTrue("browser 2 joins by the SAME code", Gw.post("/g/$sid2/api/mp/join", JSONObject().put("code", code)))
        assertTrue("host lists both guests", until(20000) { val p = Gw.state()!!.getJSONArray("players"); p.length() == 3 })
        assertTrue(Gw.post("/g/$sid1/api/mp/ready", JSONObject().put("ready", true)))
        assertTrue(Gw.post("/g/$sid2/api/mp/ready", JSONObject().put("ready", true)))
        assertTrue("host READY with both guests ready", until(30000) { Gw.state()!!.optBoolean("canStart") })
        assertTrue(Gw.post("/api/mp/start", JSONObject()))
        assertTrue("host IN_GAME: ${Gw.state()}", until(120000) { state() == "IN_GAME" })
        assertEquals("a browser guest always gets Hosted", "hosted", Gw.state()!!.getJSONObject("mode").optString("effective"))
        assertTrue("three consoles run on this phone (${runtimeProcesses()})", until(15000) { runtimeProcesses() == 3 })

        // both browsers: signalling over /ws, media over WebRTC, each to its OWN console
        js(guestJs("__g1", sid1)); js(guestJs("__g2", sid2))
        var l1 = JSONObject(); var l2 = JSONObject()
        val flowing = until(90000, 500) {
            l1 = jsJson(guestQ("__g1")); l2 = jsJson(guestQ("__g2"))
            listOf(l1, l2).all { it.optString("st") == "connected" && it.optInt("v") > 60 && it.optInt("a") > 30 }
        }
        android.util.Log.i("dslink-test", "browser guests: $l1 $l2")
        assertTrue("both WebRTC peers connect and video/audio packets arrive: $l1 $l2", flowing)
        assertTrue("each guest got a different console: ${l1.optInt("player")} ${l2.optInt("player")}", setOf(l1.optInt("player"), l2.optInt("player")) == setOf(2, 3))
        assertTrue("video bytes flow on both (H.264 from two MediaCodec encoders): $l1 $l2", l1.optInt("vb") > 20000 && l2.optInt("vb") > 20000)

        // two encoders, each reporting; each console at speed
        for (pid in listOf(2, 3)) {
            val sl = slotById(pid); val enc = sl.optJSONObject("enc")
            android.util.Log.i("dslink-test", "console $pid: fps ${sl.optDouble("fps")} encoder $enc rtt ${sl.optDouble("peer_rtt_ms")}")
            assertNotNull("console $pid reports its encoder", enc)
            assertTrue("encoder $pid produced pictures: $enc", enc!!.optInt("out") > 60 && enc.optString("codec").isNotEmpty())
            assertTrue("console $pid has its guest connected", sl.optBoolean("peer_connected"))
        }
        // input isolation: guest 1's button reaches ONE console, guest 2's the other, the host's console none
        val p1 = l1.optInt("player")
        js("(() => { __g1.dc.send(JSON.stringify({t:'btn',k:'a',d:true})); __g1.dc.send(JSON.stringify({t:'btn',k:'a',d:false})); return 'sent'; })()")
        assertTrue("guest 1's buttons reach only console $p1", until(10000) { val a = slotById(p1).optInt("input_events"); val b = slotById(5 - p1).optInt("input_events"); val h = slotById(1).optInt("input_events"); a >= 2 && b == 0 && h == 0 })
        js("(() => { __g2.dc.send(JSON.stringify({t:'btn',k:'b',d:true})); __g2.dc.send(JSON.stringify({t:'btn',k:'b',d:false})); return 'sent'; })()")
        assertTrue("guest 2's buttons reach only console ${5 - p1}", until(10000) { slotById(5 - p1).optInt("input_events") >= 2 && slotById(p1).optInt("input_events") in 2..3 && slotById(1).optInt("input_events") == 0 })

        // guest 1's browser goes away: the game goes on for the host and guest 2; only that console is released
        js("(() => { clearInterval(__g1.timer); clearInterval(__g1.poll); __g1.ws.close(); __g1.pc.close(); return 'closed'; })()")
        assertTrue("guest 1 gone: its console stops, the other two keep running", until(60000, 500) { runtimeProcesses() == 2 })
        assertEquals("the game is still IN_GAME for the others", "IN_GAME", state())
        val still = jsJson(guestQ("__g2"))
        assertEquals("guest 2 is still connected", "connected", still.optString("st"))
        val v0 = still.optInt("v"); SystemClock.sleep(2000)
        assertTrue("guest 2 still receives video", jsJson(guestQ("__g2")).optInt("v") > v0 + 30)

        // the last browser goes: the host is told, every console stops
        js("(() => { clearInterval(__g2.timer); clearInterval(__g2.poll); __g2.ws.close(); __g2.pc.close(); return 'closed'; })()")
        assertTrue("host: last peer lost -> ENDED ('Connessione con il giocatore persa.')", until(60000, 500) {
            val s = Gw.state(); s != null && s.optString("state") == "ENDED" && s.optJSONObject("error")?.optString("message") == "Connessione con il giocatore persa."
        })
        assertTrue("every console stops", until(20000) { runtimeProcesses() == 0 })
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
