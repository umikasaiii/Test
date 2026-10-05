package com.dslink.emulator;

/** Small bag of last-known values for the diagnostics screen (no persistence, no personal data). */
final class AppState {
    private AppState() {}

    static volatile String role = "";
    static volatile String remoteIp = "";
    static volatile String port = "";
    static volatile String discovery = "idle";
    static volatile String netplayState = "idle";
    static volatile String ping = "";
    static volatile String jitter = "";
    static volatile String lastError = "";
    static volatile String romSha = "";
    static volatile boolean romLoaded;
}
