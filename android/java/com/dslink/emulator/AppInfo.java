package com.dslink.emulator;

/** Versions shown in diagnostics and exchanged during the join handshake. */
final class AppInfo {
    private AppInfo() {}

    static final String APP_VERSION = "1.0.0";
    /** The melonDS DS core this build bundles (pinned in docs/UPSTREAM_VERSIONS.md). Must match on both ends. */
    static final String CORE_VERSION = "melonDS DS 1.4.0";
    static final String RETROARCH_VERSION = "RetroArch 1.22.2";
    static final int PROTOCOL_VERSION = 1;
    static final int DEFAULT_PORT = 55435;
    static final String SERVICE_TYPE = "_dslink._tcp.";
}
