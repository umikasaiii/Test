package com.dslink.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import org.json.JSONObject
import java.net.Inet4Address

data class NetSnapshot(val ip: String, val prefix: Int, val broadcast: String?)

/**
 * What the platform knows about the LAN. A process on modern Android cannot enumerate network interfaces (netlink is blocked), so the app reads the Wi-Fi
 * address from ConnectivityManager and hands it to the gateway (/api/mp/net); it is refreshed whenever the network changes.
 * Also holds the multicast lock while the lobby/discovery screens are in use (some Wi-Fi chipsets drop broadcast/multicast frames without it).
 */
class NetWatcher(private val ctx: Context) {
    private val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val wifi = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private var lock: WifiManager.MulticastLock? = null
    private var cb: ConnectivityManager.NetworkCallback? = null
    @Volatile var current: NetSnapshot? = snapshot()
        private set

    fun snapshot(): NetSnapshot? {
        val net = cm.activeNetwork ?: return null
        val caps = cm.getNetworkCapabilities(net)
        if (caps != null && !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return null
        return from(cm.getLinkProperties(net))
    }

    private fun from(lp: LinkProperties?): NetSnapshot? {
        lp ?: return null
        for (a in lp.linkAddresses) {
            val ip = (a.address as? Inet4Address)?.hostAddress ?: continue
            if (!NetMath.isLan(ip)) continue
            return NetSnapshot(ip, a.prefixLength, NetMath.broadcast(ip, a.prefixLength))
        }
        return null
    }

    fun start() {
        acquireMulticast()
        if (cb != null) return
        val c = object : ConnectivityManager.NetworkCallback() {
            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) { push(from(lp)) }
            override fun onLost(network: Network) { push(snapshot()) }
        }
        cb = c
        try { cm.registerDefaultNetworkCallback(c) } catch (_: Exception) { cb = null }
        push(current)
    }

    fun stop() {
        releaseMulticast()
        cb?.let { try { cm.unregisterNetworkCallback(it) } catch (_: Exception) { } }
        cb = null
    }

    private fun push(s: NetSnapshot?) {
        current = s
        Thread {
            Gw.post("/api/mp/net", JSONObject().put("ip", s?.ip ?: "").put("broadcast", s?.broadcast ?: ""))
        }.start()
    }

    private fun acquireMulticast() {
        if (lock == null) lock = wifi.createMulticastLock("dslink-lan").apply { setReferenceCounted(false) }
        if (lock?.isHeld == false) lock?.acquire()
    }

    private fun releaseMulticast() { if (lock?.isHeld == true) lock?.release() }
}
