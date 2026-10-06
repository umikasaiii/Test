package com.dslink.app

/** JNI surface (native/jni_bridge.cpp). The C++ owns video (GL), audio (AAudio), input and the validation of the user's private files. */
object Native {
    init { System.loadLibrary("dslink_jni") }

    @JvmStatic external fun nativeInit(shmPath: String)
    @JvmStatic external fun nativeShutdown()
    @JvmStatic external fun nativeSetSurface(surface: android.view.Surface?)
    @JvmStatic external fun nativeSetLayout(cl: Float, ct: Float, cr: Float, cb: Float, vl: Float, vt: Float, vr: Float, vb: Float, linear: Boolean)
    @JvmStatic external fun nativeSetVisible(visible: Boolean)
    @JvmStatic external fun nativeButton(id: Int, down: Boolean)
    @JvmStatic external fun nativeTouch(x: Float, y: Float, down: Boolean)
    @JvmStatic external fun nativeReleaseAll()
    @JvmStatic external fun nativeSetPaused(paused: Boolean)
    @JvmStatic external fun nativeRequestQuit()
    @JvmStatic external fun nativePadId(name: String): Int
    @JvmStatic external fun nativeMetrics(): DoubleArray
    @JvmStatic external fun nativeGrabFrame(): ByteArray?
    @JvmStatic external fun nativeCheckSysFile(kind: Int, path: String): String
    @JvmStatic external fun nativeInspectRom(path: String): String
}
