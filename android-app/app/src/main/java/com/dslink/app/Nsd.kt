package com.dslink.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Android NSD (mDNS/DNS-SD) discovery of DSLink rooms, the platform-native way. The gateway still does its own UDP discovery (broadcast + hints); NSD adds
 * what the platform sees: every phone that advertises "_dslink._tcp" is handed to the gateway as a unicast hint (/api/mp/hints), so PARTITE VICINE works
 * on networks that drop broadcast. Nothing here ever shows an address to the user.
 */
class NsdHelper(ctx: Context, private val net: NetWatcher) {
    private val nsd = ctx.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val found = ConcurrentHashMap<String, String>()   // service name -> IPv4
    private var disc: NsdManager.DiscoveryListener? = null
    private var reg: NsdManager.RegistrationListener? = null
    private var registeredRoom: String? = null
    private val pending = ArrayDeque<NsdServiceInfo>()
    private var resolving = false

    companion object { const val TYPE = "_dslink._tcp."; private const val TAG = "dslink-nsd" }

    @Synchronized
    fun startDiscovery() {
        if (disc != null) return
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(t: String) {}
            override fun onDiscoveryStopped(t: String) {}
            override fun onStartDiscoveryFailed(t: String, e: Int) { Log.w(TAG, "discovery start failed $e"); disc = null }
            override fun onStopDiscoveryFailed(t: String, e: Int) {}
            override fun onServiceFound(i: NsdServiceInfo) { enqueue(i) }
            override fun onServiceLost(i: NsdServiceInfo) { found.remove(i.serviceName); push() }
        }
        disc = l
        try { nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, l) } catch (e: Exception) { Log.w(TAG, "discoverServices", e); disc = null }
    }

    @Synchronized
    fun stopDiscovery() {
        disc?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) { } }
        disc = null; found.clear(); pending.clear(); resolving = false
        push()
    }

    /** advertise this phone's open room (called while the lobby is open); the TXT record carries the room id only, never the code or the secret */
    @Synchronized
    fun register(roomId: String) {
        if (registeredRoom == roomId) return
        unregister()
        val info = NsdServiceInfo().apply {
            serviceName = "DSLink-" + roomId.take(8); serviceType = TYPE; port = Stack.HTTP_PORT
            setAttribute("r", roomId)
        }
        val l = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(i: NsdServiceInfo) {}
            override fun onRegistrationFailed(i: NsdServiceInfo, e: Int) { Log.w(TAG, "register failed $e"); registeredRoom = null }
            override fun onServiceUnregistered(i: NsdServiceInfo) {}
            override fun onUnregistrationFailed(i: NsdServiceInfo, e: Int) {}
        }
        reg = l; registeredRoom = roomId
        try { nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l) } catch (e: Exception) { Log.w(TAG, "registerService", e); reg = null; registeredRoom = null }
    }

    @Synchronized
    fun unregister() {
        reg?.let { try { nsd.unregisterService(it) } catch (_: Exception) { } }
        reg = null; registeredRoom = null
    }

    @Synchronized private fun enqueue(i: NsdServiceInfo) { pending.addLast(i); next() }

    // NsdManager resolves one service at a time
    @Synchronized private fun next() {
        if (resolving) return
        val i = pending.removeFirstOrNull() ?: return
        resolving = true
        try {
            @Suppress("DEPRECATION")
            nsd.resolveService(i, object : NsdManager.ResolveListener {
                override fun onResolveFailed(s: NsdServiceInfo, e: Int) { done() }
                override fun onServiceResolved(s: NsdServiceInfo) {
                    @Suppress("DEPRECATION") val ip = s.host?.hostAddress
                    if (ip != null && ip.indexOf(':') < 0 && ip != net.current?.ip) { found[s.serviceName] = ip; push() }
                    done()
                }
            })
        } catch (_: Exception) { done() }
    }

    @Synchronized private fun done() { resolving = false; next() }

    private fun push() {
        val arr = JSONArray(found.values.toList())
        Thread { Gw.post("/api/mp/hints", JSONObject().put("addrs", arr)) }.start()
    }
}
