package com.dslink.emulator;

import java.util.HashMap;
import java.util.Map;

/** Thin bridge to the portable C++ DSLink library (dslink/). All structured data is "key=value\n" text. */
final class DsLink {
    private DsLink() {}

    static {
        System.loadLibrary("dslink_jni");
    }

    static native String identityLoadOrCreate(String path);
    static native String identityRename(String path, String name);
    static native String identityBumpSalt(String path);
    static native String bestIPv4();
    static native int pickPort(int preferred);
    static native String sha256File(String path);
    static native String validateSystemDir(String dir);
    static native String ndsInfo(String path);
    static native String advertNormalize(String kv);
    static native String advertDecode(String wire);
    static native String compatMessage(String code);
    static native long hostStart(String advertKv, String nick, String mac, int port, boolean beacon);
    static native String hostPeers(long handle);
    static native void hostStop(long handle);
    static native String hello(String ip, int port, String infoKv, String mac);
    static native void bye(String ip, int port, String deviceId);
    static native String probe(String ip, int port, int count);
    static native long beaconListen();
    static native String beaconRooms(long handle);
    static native void beaconStop(long handle);
    static native long smNew();
    static native boolean smEvent(long handle, String event, String info, int remainingPeers);
    static native String smState(long handle);
    static native void smFree(long handle);
    static native String launchConfig(String planKv);
    static native String launchCoreOptions(String planKv);
    static native String launchNetplayExtra(String planKv);
    static native void log(String line);
    static native String logDump();
    static native String diagnostics(String reportKv);
    static native String lastError();

    /** Parses "k=v\n" text. Never returns null. */
    static Map<String, String> kv(String text) {
        Map<String, String> m = new HashMap<>();
        if (text == null) return m;
        for (String line : text.split("\n")) {
            int eq = line.indexOf('=');
            if (eq > 0) m.put(line.substring(0, eq), line.substring(eq + 1));
        }
        return m;
    }

    static String encode(Map<String, String> m) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : m.entrySet()) {
            String v = e.getValue() == null ? "" : e.getValue().replace('\n', ' ').replace('\r', ' ');
            sb.append(e.getKey()).append('=').append(v).append('\n');
        }
        return sb.toString();
    }

    static int parseInt(String s, int def) {
        try {
            return Integer.parseInt(s);
        } catch (Exception e) {
            return def;
        }
    }
}
