package com.dslink.emulator;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;

import java.util.Map;

/** Reads the LAN situation (IPv4, link type, VPN) and watches for network loss while a session is active. */
final class NetInfo {
    private NetInfo() {}

    static final class Lan {
        boolean found;
        String ip = "", iface = "", kind = "";
        int prefix;
        boolean vpn;

        String subnet() {
            return found ? ip + "/" + prefix : "";
        }
    }

    static Lan lan() {
        Map<String, String> m = DsLink.kv(DsLink.bestIPv4());
        Lan l = new Lan();
        l.found = "1".equals(m.get("found"));
        l.ip = m.containsKey("ip") ? m.get("ip") : "";
        l.iface = m.containsKey("iface") ? m.get("iface") : "";
        l.kind = m.containsKey("kind") ? m.get("kind") : "";
        l.prefix = DsLink.parseInt(m.get("prefix"), 0);
        l.vpn = "1".equals(m.get("vpn"));
        return l;
    }

    /** A user-facing label for the connection type. */
    static String kindLabel(String kind) {
        switch (kind == null ? "" : kind) {
            case "wifi": return "Wi-Fi";
            case "hotspot": return "Hotspot";
            case "ethernet": return "Ethernet";
            default: return kind == null || kind.isEmpty() ? "Nessuna rete" : kind;
        }
    }

    static boolean wifiEnabled(Context c) {
        try {
            WifiManager wm = (WifiManager) c.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            return wm != null && wm.isWifiEnabled();
        } catch (Exception e) {
            return true;
        }
    }

    /** True when any active network is a VPN (the DS wireless protocol cannot tolerate tunnels). */
    static boolean vpnActive(Context c) {
        try {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return true;
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    interface Listener {
        void onNetworkLost();
    }

    /** Calls back when the default network goes away (Wi-Fi switched off, left the network...). */
    static ConnectivityManager.NetworkCallback watch(Context c, final Listener l) {
        ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
        ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onLost(Network network) {
                l.onNetworkLost();
            }
        };
        try {
            NetworkRequest req = new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
                    .build();
            cm.registerNetworkCallback(req, cb);
        } catch (Exception e) {
            DsLink.log("network watch unavailable: " + e.getClass().getSimpleName());
        }
        return cb;
    }

    static void unwatch(Context c, ConnectivityManager.NetworkCallback cb) {
        if (cb == null) return;
        try {
            ((ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE)).unregisterNetworkCallback(cb);
        } catch (Exception ignored) {
        }
    }
}
