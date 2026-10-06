package com.dslink.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * One full-screen window with two layers:
 *  - a SurfaceView at the back: the native renderer draws the console's raw frames there (GL, from shared memory, no copy through JavaScript);
 *  - the WebView on top, transparent while a game runs: the approved multiplayer UI and the FROZEN touch controls, unchanged.
 * The page tells us (Bridge.setLayout) where the controls engine put the picture; the renderer draws exactly there.
 */
class MainActivity : ComponentActivity(), SurfaceHolder.Callback {
    private lateinit var surfaceView: SurfaceView
    private lateinit var web: WebView
    val webView: WebView get() = web   // instrumented tests
    private lateinit var overlay: TextView
    private lateinit var monitor: DevMonitor
    private lateinit var net: NetWatcher
    private lateinit var nsd: NsdHelper
    private val ui = Handler(Looper.getMainLooper())
    private var fileCb: ValueCallback<Array<Uri>>? = null
    private var pendingPerm: PermissionRequest? = null
    @Volatile private var gameVisible = false
    @Volatile private var resumed = false
    private var focusReq: AudioFocusRequest? = null
    private var watcher: Thread? = null
    @Volatile private var watching = false
    @Volatile private var pageLoaded = false

    private val picker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data)); fileCb = null
    }
    private val camera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        pendingPerm?.let { if (ok) it.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else it.deny() }; pendingPerm = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        Native.nativeInit(Stack.shmPath(this))
        net = NetWatcher(this)
        nsd = NsdHelper(this, net)

        val root = FrameLayout(this)
        surfaceView = SurfaceView(this).also { it.holder.addCallback(this) }
        web = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.apply {
                javaScriptEnabled = true; domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = false; allowContentAccess = true
                cacheMode = WebSettings.LOAD_NO_CACHE
                setSupportZoom(false)
            }
            addJavascriptInterface(Bridge(this@MainActivity), "DSLinkAndroid")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest) = !(r.url.host == "127.0.0.1" || r.url.host == "localhost")
                override fun onRenderProcessGone(v: WebView, d: RenderProcessGoneDetail): Boolean { ui.post { recreate() }; return true }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                    fileCb?.onReceiveValue(null); fileCb = cb
                    return try { picker.launch(p.createIntent()); true } catch (_: Exception) { fileCb = null; false }
                }
                override fun onPermissionRequest(req: PermissionRequest) {
                    if (!req.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) { req.deny(); return }
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) req.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    else { pendingPerm = req; camera.launch(Manifest.permission.CAMERA) }
                }
            }
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        }
        overlay = TextView(this).apply {
            typeface = Typeface.MONOSPACE; setTextSize(TypedValue.COMPLEX_UNIT_SP, 9f); setTextColor(Color.WHITE); setBackgroundColor(0xAA000000.toInt())
            setPadding(12, 6, 12, 6); visibility = View.GONE; isClickable = false
        }
        root.addView(surfaceView, FrameLayout.LayoutParams(-1, -1))
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        root.addView(overlay, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.START).apply { topMargin = 40; leftMargin = 8 })
        setContentView(root)
        monitor = DevMonitor(this, overlay)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            // the page decides: inside a session it asks before leaving; a sub-screen goes back home; at home the task just moves to the background
            override fun handleOnBackPressed() { web.evaluateJavascript("(window.dslinkBack && window.dslinkBack()) === true") { v -> if (v != "true") moveTaskToBack(true) } }
        })
        startStack()
    }

    private fun startStack() {
        Thread {
            val ok = Stack.ensureStarted(this, net.snapshot()) && Stack.waitReady()
            ui.post {
                if (ok) { web.loadUrl(Gw.url("/mp/")); pageLoaded = true }
                else web.loadData("<body style='background:#050912;color:#fff;font:16px sans-serif;padding:24px'><h2>DSLink non riesce ad avviarsi</h2><p>Riprova più tardi.</p></body>", "text/html", "utf-8")
            }
        }.start()
    }

    // ---- surface (native renderer target)
    override fun surfaceCreated(h: SurfaceHolder) { Native.nativeSetSurface(h.surface) }
    override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, hh: Int) { Native.nativeSetSurface(h.surface) }
    override fun surfaceDestroyed(h: SurfaceHolder) { Native.nativeSetSurface(null) }

    // ---- called by the page (Bridge)
    fun onLayout(cl: Float, ct: Float, cr: Float, cb: Float, vl: Float, vt: Float, vr: Float, vb: Float, linear: Boolean) = Native.nativeSetLayout(cl, ct, cr, cb, vl, vt, vr, vb, linear)

    fun onGameVisible(v: Boolean) {
        ui.post {
            gameVisible = v
            Native.nativeSetVisible(v)
            net.gameWifi(v)
            if (v) { window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); requestFocus(); if (resumed) Native.nativeSetPaused(false) }
            else { window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); abandonFocus(); Native.nativeSetPaused(false); Native.nativeReleaseAll() }
        }
    }

    fun openSystemFiles() { ui.post { startActivity(Intent(this, SystemFilesActivity::class.java)) } }
    fun setDevOverlay(on: Boolean) { ui.post { monitor.enable(on) } }

    // ---- audio focus: a phone call, another player, an alarm -> pause; back -> resume
    private fun requestFocus() {
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        val r = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setOnAudioFocusChangeListener { change ->
                ui.post {
                    if (isDestroyed || isFinishing) return@post   // a finished activity must never pause the console that its successor now owns
                    when (change) {
                        AudioManager.AUDIOFOCUS_GAIN -> if (gameVisible && resumed) Native.nativeSetPaused(false)
                        AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> if (gameVisible) Native.nativeSetPaused(true)
                    }
                }
            }.build()
        focusReq = r
        am.requestAudioFocus(r)
    }

    private fun abandonFocus() { focusReq?.let { (getSystemService(AUDIO_SERVICE) as AudioManager).abandonAudioFocusRequest(it) }; focusReq = null }

    // ---- lifecycle: background / screen lock / app switch pause the emulation (the gateway's grace window covers a short absence)
    override fun onResume() {
        super.onResume()
        resumed = true
        net.start(); nsd.startDiscovery()
        if (gameVisible) Native.nativeSetPaused(false)
        startWatcher()
    }

    override fun onPause() {
        resumed = false
        Native.nativeReleaseAll()                   // a finger that was down when the app left must not stay "pressed"
        if (gameVisible) Native.nativeSetPaused(true)
        watching = false
        nsd.stopDiscovery(); nsd.unregister(); net.stop()
        super.onPause()
    }

    override fun onDestroy() {
        abandonFocus()
        if (isFinishing) {
            monitor.enable(false)
            Native.nativeRequestQuit()
            // never block the UI thread on process shutdown (SIGTERM + wait): that is how an app earns an ANR. The native engine itself lives as long
            // as the process (idle without a surface / a Runtime), so a new activity can start while the old gateway is still being stopped.
            Thread { Stack.stop() }.start()
        }
        web.destroy()
        super.onDestroy()
    }

    /** keeps NSD advertising in step with the lobby and revives the gateway if it ever died */
    private fun startWatcher() {
        if (watching) return
        watching = true
        watcher = Thread {
            while (watching) {
                try {
                    if (pageLoaded && !Stack.running()) { Log.w("dslink", "gateway died, restarting"); if (Stack.ensureStarted(this, net.snapshot()) && Stack.waitReady()) ui.post { web.reload() } }
                    val s = Gw.state(true)
                    if (s != null) {
                        val st = s.optString("state"); val role = s.optString("role")
                        val room = s.optJSONObject("dev")?.optString("roomId") ?: ""
                        if (role == "host" && room.isNotEmpty() && st in setOf("WAITING_FOR_PEER", "CONNECTED", "NETWORK_CHECK", "READY")) nsd.register(room) else nsd.unregister()
                    }
                } catch (_: Exception) { }
                try { Thread.sleep(1000) } catch (_: InterruptedException) { return@Thread }
            }
        }.also { it.isDaemon = true; it.start() }
    }
}
