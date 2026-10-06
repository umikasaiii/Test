package com.dslink.app

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Loopback HTTP to this phone's own gateway (the only thing the UI API answers). */
object Gw {
    fun url(path: String) = "http://127.0.0.1:${Stack.HTTP_PORT}$path"

    fun get(path: String, timeoutMs: Int = 1500): String? = try {
        val c = URL(url(path)).openConnection() as HttpURLConnection
        c.connectTimeout = timeoutMs; c.readTimeout = timeoutMs
        try { if (c.responseCode == 200) c.inputStream.bufferedReader().readText() else null } finally { c.disconnect() }
    } catch (_: Exception) { null }

    fun post(path: String, body: JSONObject, timeoutMs: Int = 1500): Boolean = try {
        val c = URL(url(path)).openConnection() as HttpURLConnection
        c.connectTimeout = timeoutMs; c.readTimeout = timeoutMs; c.requestMethod = "POST"; c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        try { c.responseCode == 200 } finally { c.disconnect() }
    } catch (_: Exception) { false }

    fun state(dev: Boolean = false): JSONObject? = get("/api/mp/state" + if (dev) "?dev=1" else "")?.let { runCatching { JSONObject(it) }.getOrNull() }
}
