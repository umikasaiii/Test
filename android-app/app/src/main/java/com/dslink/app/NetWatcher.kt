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
    @Volatile private var watching = false
    @Volatile var current: NetSnapshot? = snapshot()
        private set

    fun snapshot(): NetSnapshot? {
        val net = cm.activeNetwork ?: return hotspot()
        val caps = cm.getNetworkCapabilities(net)
        if (caps != null && !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return hotspot()
        return from(cm.getLinkProperties(net)) ?: hotspot()
    }

    /**
     * This phone is the access point (its own hotspot, e.g. an iPhone joined to the Honor): there is no "Wi-Fi network" for ConnectivityManager, the LAN address
     * lives on the tethering interface. Java can still enumerate interfaces (native code cannot); mobile data, VPN and Wi-Fi Direct interfaces are skipped.
     * Best effort: where the platform hides the interface the host simply has no LAN address to advertise.
     */
    private fun hotspot(): NetSnapshot? = try {
        var found: NetSnapshot? = null
        for (ni in java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces())) {
            val n = ni.name.lowercase()
            if (!ni.isUp || ni.isLoopback || ni.isVirtual || n.startsWith("rmnet") || n.startsWith("ccmni") || n.startsWith("v4-") || n.startsWith("tun") || n.startsWith("dummy") || n.startsWith("p2p")) continue
            for (ia in ni.interfaceAddresses) {
                val ip = (ia.address as? Inet4Address)?.hostAddress ?: continue
                if (!NetMath.isLan(ip)) continue
                found = NetSnapshot(ip, ia.networkPrefixLength.toInt(), NetMath.broadcast(ip, ia.networkPrefixLength.toInt()))
                break
            }
            if (found != null) break
        }
        found
    } catch (_: Exception) { null }

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
        watching = true
        Thread {   // the hotspot switching on/off is not a "network" event: look again every few seconds while the app is in use
            while (watching) {
                try { Thread.sleep(4000) } catch (_: InterruptedException) { return@Thread }
                val s = snapshot()
                if (s != current) push(s)
            }
        }.apply { isDaemon = true; start() }
    }

    fun stop() {
        watching = false
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
