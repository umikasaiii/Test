package com.dslink.app

import android.webkit.JavascriptInterface

/**
 * What the page (the approved web UI + frozen touch controls) can call. Same shape as the data channel the browser version uses:
 * buttons by RetroPad name, stylus as normalised coordinates over the frame, plus the two rectangles that tell the native surface where the picture goes.
 * Methods run on the WebView's bridge thread: they only touch lock-free native state, everything visual is posted to the UI thread.
 */
class Bridge(private val act: MainActivity) {
    @JavascriptInterface fun btn(name: String, down: Boolean) {
        val id = Native.nativePadId(name)
        if (id >= 0) Native.nativeButton(id, down)
    }

    @JavascriptInterface fun touch(x: Double, y: Double, down: Boolean) = Native.nativeTouch(x.toFloat(), y.toFloat(), down)

    @JavascriptInterface fun setLayout(cl: Double, ct: Double, cr: Double, cb: Double, vl: Double, vt: Double, vr: Double, vb: Double, linear: Boolean) =
        act.onLayout(cl.toFloat(), ct.toFloat(), cr.toFloat(), cb.toFloat(), vl.toFloat(), vt.toFloat(), vr.toFloat(), vb.toFloat(), linear)

    @JavascriptInterface fun gameVisible(visible: Boolean) = act.onGameVisible(visible)
    @JavascriptInterface fun openSystemFiles() = act.openSystemFiles()
    @JavascriptInterface fun setDevOverlay(on: Boolean) = act.setDevOverlay(on)
    @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME

    /** Developer menu: encodes synthetic frames with this phone's H.264 encoder, decodes them again and reports codec/hardware/fps/latency/bitrate as one JSON line (takes a few seconds). */
    @JavascriptInterface fun encoderSelfTest(): String = Stack.encoderSelfTest(act)
}
