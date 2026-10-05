package com.dslink.emulator;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;

import java.net.InetAddress;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;

/**
 * LAN discovery of DSLink rooms: mDNS / DNS-SD ("_dslink._tcp", interoperable with Bonjour on iOS) plus the UDP
 * broadcast beacon implemented in the native library. A MulticastLock is held only while discovering/advertising.
 */
final class Discovery {

    static final class Room {
        String name = "", game = "", ip = "", sessionId = "", mode = "", appVersion = "", coreVersion = "";
        int port, players, max, protocol;
        String source = "";
        long lastSeen;

        String key() { return sessionId.isEmpty() ? ip + ":" + port : sessionId; }
    }

    interface Listener {
        void onRoomsChanged(List<Room> rooms);
    }

    private final Context ctx;
    private final NsdManager nsd;
    private final Handler main = new Handler(Looper.getMainLooper());
    private WifiManager.MulticastLock lock;
    private NsdManager.DiscoveryListener discoveryListener;
    private NsdManager.RegistrationListener registrationListener;
    private long beacon;
    private Thread poller;
    private volatile boolean running;
    private final Map<String, Room> rooms = new LinkedHashMap<>();
    private final LinkedList<NsdServiceInfo> resolveQueue = new LinkedList<>();
    private boolean resolving;
    private Listener listener;
    private String state = "idle";

    Discovery(Context c) {
        ctx = c.getApplicationContext();
        nsd = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
    }

    String state() { return state; }

    private void acquireLock() {
        try {
            if (lock == null) {
                WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
                lock = wm.createMulticastLock("dslink-discovery");
                lock.setReferenceCounted(false);
            }
            if (!lock.isHeld()) lock.acquire();
        } catch (Exception e) {
            DsLink.log("multicast lock unavailable: " + e.getClass().getSimpleName());
        }
    }

    private void releaseLock() {
        try {
            if (lock != null && lock.isHeld()) lock.release();
        } catch (Exception ignored) {
        }
    }

    // ---- client side -------------------------------------------------------------------------------------

    void startBrowsing(Listener l) {
        listener = l;
        running = true;
        state = "searching";
        acquireLock();
        DsLink.log("[discovery] start browsing");
        try {
            discoveryListener = new NsdManager.DiscoveryListener() {
                @Override public void onDiscoveryStarted(String t) { DsLink.log("[discovery] mDNS started"); }
                @Override public void onStartDiscoveryFailed(String t, int e) {
                    state = "mdns-failed";
                    DsLink.log("[discovery] mDNS start failed " + e);
                }
                @Override public void onStopDiscoveryFailed(String t, int e) {}
                @Override public void onDiscoveryStopped(String t) {}
                @Override public void onServiceFound(NsdServiceInfo s) { enqueueResolve(s); }
                @Override public void onServiceLost(NsdServiceInfo s) {
                    synchronized (rooms) {
                        for (Room r : new ArrayList<>(rooms.values()))
                            if (r.source.equals("mdns") && s.getServiceName().equals(r.name)) rooms.remove(r.key());
                    }
                    publish();
                }
            };
            nsd.discoverServices(AppInfo.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        } catch (Exception e) {
            state = "mdns-failed";
            DsLink.log("[discovery] mDNS exception " + e.getClass().getSimpleName());
        }
        beacon = DsLink.beaconListen();
        if (beacon == 0) DsLink.log("[discovery] beacon listener unavailable: " + DsLink.lastError());
        poller = new Thread(() -> {
            while (running) {
                pollBeacon();
                try { Thread.sleep(700); } catch (InterruptedException e) { return; }
            }
        }, "dslink-beacon-poll");
        poller.start();
    }

    private void pollBeacon() {
        if (beacon == 0) return;
        Map<String, String> m = DsLink.kv(DsLink.beaconRooms(beacon));
        int count = DsLink.parseInt(m.get("count"), 0);
        long now = System.currentTimeMillis();
        synchronized (rooms) {
            // drop stale beacon rooms, refresh live ones
            for (Room r : new ArrayList<>(rooms.values()))
                if (r.source.equals("beacon") && now - r.lastSeen > 5000) rooms.remove(r.key());
            for (int i = 0; i < count; i++) {
                String p = "room" + i + "_";
                Room r = new Room();
                r.name = nz(m.get(p + "room"));
                r.game = nz(m.get(p + "game"));
                // The packet's real source address is more trustworthy than the advertised one.
                r.ip = m.containsKey(p + "src") ? m.get(p + "src") : nz(m.get(p + "ip"));
                r.port = DsLink.parseInt(m.get(p + "port"), 0);
                r.sessionId = nz(m.get(p + "session"));
                r.mode = nz(m.get(p + "mode"));
                r.appVersion = nz(m.get(p + "app"));
                r.coreVersion = nz(m.get(p + "core"));
                r.protocol = DsLink.parseInt(m.get(p + "proto"), 0);
                r.players = DsLink.parseInt(m.get(p + "players"), 1);
                r.max = DsLink.parseInt(m.get(p + "max"), 4);
                r.source = "beacon";
                r.lastSeen = now;
                rooms.put(r.key(), r);
            }
        }
        publish();
    }

    private static String nz(String s) { return s == null ? "" : s; }

    private void enqueueResolve(NsdServiceInfo s) {
        synchronized (resolveQueue) {
            resolveQueue.add(s);
        }
        nextResolve();
    }

    private void nextResolve() {
        final NsdServiceInfo s;
        synchronized (resolveQueue) {
            if (resolving || resolveQueue.isEmpty()) return;
            s = resolveQueue.removeFirst();
            resolving = true;
        }
        try {
            nsd.resolveService(s, new NsdManager.ResolveListener() {
                @Override public void onResolveFailed(NsdServiceInfo i, int e) { done(); }
                @Override public void onServiceResolved(NsdServiceInfo i) {
                    handleResolved(i);
                    done();
                }
                private void done() {
                    synchronized (resolveQueue) { resolving = false; }
                    nextResolve();
                }
            });
        } catch (Exception e) {
            synchronized (resolveQueue) { resolving = false; }
        }
    }

    private void handleResolved(NsdServiceInfo i) {
        Map<String, byte[]> attrs = i.getAttributes();
        InetAddress host = i.getHost();
        if (host == null || host.getAddress().length != 4) return;  // IPv4 only
        Room r = new Room();
        r.name = nz(txt(attrs, "room"));
        if (r.name.isEmpty()) r.name = i.getServiceName();
        r.game = nz(txt(attrs, "game"));
        r.ip = host.getHostAddress();
        r.port = i.getPort();
        r.sessionId = nz(txt(attrs, "session"));
        r.mode = nz(txt(attrs, "mode"));
        r.appVersion = nz(txt(attrs, "app"));
        r.coreVersion = nz(txt(attrs, "core"));
        r.protocol = DsLink.parseInt(txt(attrs, "proto"), 0);
        r.players = DsLink.parseInt(txt(attrs, "players"), 1);
        r.max = DsLink.parseInt(txt(attrs, "max"), 4);
        r.source = "mdns";
        r.lastSeen = System.currentTimeMillis();
        synchronized (rooms) {
            // The beacon and mDNS may both report the same room; keep a single entry.
            rooms.put(r.key(), r);
        }
        publish();
    }

    private static String txt(Map<String, byte[]> a, String k) {
        if (a == null || !a.containsKey(k) || a.get(k) == null) return null;
        return new String(a.get(k));
    }

    private void publish() {
        final List<Room> copy;
        synchronized (rooms) {
            copy = new ArrayList<>(rooms.values());
        }
        Collections.sort(copy, (a, b) -> a.name.compareToIgnoreCase(b.name));
        if (listener != null) main.post(() -> { if (listener != null) listener.onRoomsChanged(copy); });
    }

    void stopBrowsing() {
        running = false;
        listener = null;
        if (poller != null) poller.interrupt();
        if (discoveryListener != null) {
            try { nsd.stopServiceDiscovery(discoveryListener); } catch (Exception ignored) {}
            discoveryListener = null;
        }
        if (beacon != 0) {
            DsLink.beaconStop(beacon);
            beacon = 0;
        }
        synchronized (rooms) { rooms.clear(); }
        state = "idle";
        releaseLock();
    }

    // ---- host side ---------------------------------------------------------------------------------------

    /** Publishes the room over mDNS (the native layer separately sends the UDP beacon). */
    void advertise(Map<String, String> advert) {
        acquireLock();
        NsdServiceInfo info = new NsdServiceInfo();
        info.setServiceName(advert.get("room"));
        info.setServiceType(AppInfo.SERVICE_TYPE);
        info.setPort(DsLink.parseInt(advert.get("port"), AppInfo.DEFAULT_PORT));
        for (String k : new String[]{"proto", "app", "core", "room", "game", "session", "host", "mode", "console", "players", "max"})
            if (advert.get(k) != null) info.setAttribute(k, advert.get(k));
        registrationListener = new NsdManager.RegistrationListener() {
            @Override public void onRegistrationFailed(NsdServiceInfo i, int e) { DsLink.log("[discovery] mDNS register failed " + e); }
            @Override public void onUnregistrationFailed(NsdServiceInfo i, int e) {}
            @Override public void onServiceRegistered(NsdServiceInfo i) { DsLink.log("[discovery] mDNS registered as " + i.getServiceName()); }
            @Override public void onServiceUnregistered(NsdServiceInfo i) {}
        };
        try {
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registrationListener);
            state = "advertising";
        } catch (Exception e) {
            state = "mdns-failed";
            DsLink.log("[discovery] register exception " + e.getClass().getSimpleName());
        }
    }

    void stopAdvertising() {
        if (registrationListener != null) {
            try { nsd.unregisterService(registrationListener); } catch (Exception ignored) {}
            registrationListener = null;
        }
        state = "idle";
        releaseLock();
    }
}
