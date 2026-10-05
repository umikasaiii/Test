package com.dslink.emulator;

import android.content.Context;
import android.net.ConnectivityManager;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Process-wide host session: control server + UDP beacon + mDNS advert + state machine. It outlives HostActivity
 * so that clients stay connected while the emulator (RetroActivityFuture) is in the foreground.
 */
final class HostSession {
    private static HostSession current;

    static synchronized HostSession get() { return current; }

    interface Listener {
        void onPlayersChanged(List<String> nicks);
        void onError(String message);
    }

    final Map<String, String> advert = new LinkedHashMap<>();
    final String nick, mac, deviceId;
    final int port;
    final String romTitle, romSha;
    private final Context app;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Discovery discovery;
    private long server;
    private long sm;
    private volatile boolean running;
    private Thread poller;
    private Listener listener;
    private ConnectivityManager.NetworkCallback netCb;
    private List<String> lastPlayers = new ArrayList<>();
    String lastError = "";

    private HostSession(Context c, String title, String sha, Map<String, String> identity, NetInfo.Lan lan, int port, String roomName) {
        app = c.getApplicationContext();
        this.port = port;
        romTitle = title;
        romSha = sha;
        nick = identity.get("nick");
        mac = identity.get("mac");
        deviceId = identity.get("device_id");
        discovery = new Discovery(app);
        advert.put("proto", String.valueOf(AppInfo.PROTOCOL_VERSION));
        advert.put("app", AppInfo.APP_VERSION);
        advert.put("core", AppInfo.CORE_VERSION);
        advert.put("room", roomName);
        advert.put("ip", lan.ip);
        advert.put("port", String.valueOf(port));
        advert.put("game", title);
        advert.put("session", UUID.randomUUID().toString().replace("-", "").substring(0, 12));
        advert.put("host", deviceId);
        advert.put("mode", "download-play");
        advert.put("console", "nds");
        advert.put("players", "1");
        advert.put("max", "4");
    }

    /** Creates and starts a session. Returns null and fills err[0] with a user-facing message on failure. */
    static synchronized HostSession start(Context c, String title, String sha, Map<String, String> identity,
                                          String roomName, String[] err) {
        if (current != null) current.stop();
        NetInfo.Lan lan = NetInfo.lan();
        if (!lan.found) {
            err[0] = NetInfo.wifiEnabled(c)
                    ? "Non sei connesso a una rete locale.\nConnettiti alla stessa Wi-Fi degli altri giocatori o attiva l'hotspot."
                    : "Il Wi-Fi è disattivato.\nAttivalo e connettiti alla stessa rete degli altri giocatori.";
            return null;
        }
        int port = DsLink.pickPort(AppInfo.DEFAULT_PORT);
        if (port == 0) {
            err[0] = "Nessuna porta di rete disponibile (porta occupata).\nChiudi le altre app di gioco e riprova.";
            return null;
        }
        HostSession s = new HostSession(c, title, sha, identity, lan, port, roomName);
        s.sm = DsLink.smNew();
        DsLink.smEvent(s.sm, "StartHost", "", -1);
        s.server = DsLink.hostStart(DsLink.encode(s.advert), s.nick, s.mac, port, true);
        if (s.server == 0) {
            String why = DsLink.lastError();
            DsLink.smEvent(s.sm, "Fail", why, -1);
            err[0] = why.contains("occupata") ? "Porta occupata. Riprova." : "Impossibile avviare la stanza (" + why + ").";
            DsLink.smFree(s.sm);
            return null;
        }
        s.discovery.advertise(s.advert);
        DsLink.smEvent(s.sm, "Prepared", "", -1);
        s.running = true;
        s.netCb = NetInfo.watch(c, () -> s.fail("Connessione di rete persa."));
        s.poller = new Thread(s::pollLoop, "dslink-host-poll");
        s.poller.start();
        current = s;
        AppState.role = "host";
        AppState.remoteIp = "";
        AppState.port = String.valueOf(port);
        AppState.netplayState = "hosting";
        return s;
    }

    void setListener(Listener l) {
        listener = l;
        if (l != null) l.onPlayersChanged(lastPlayers);
    }

    List<String> players() { return lastPlayers; }

    private void pollLoop() {
        while (running) {
            Map<String, String> m = DsLink.kv(DsLink.hostPeers(server));
            int n = DsLink.parseInt(m.get("count"), 0);
            final List<String> names = new ArrayList<>();
            for (int i = 0; i < n; i++) names.add(m.get("peer" + i + "_nick") + " (" + m.get("peer" + i + "_ip") + ")");
            if (!names.equals(lastPlayers)) {
                boolean joined = names.size() > lastPlayers.size();
                lastPlayers = names;
                DsLink.smEvent(sm, joined ? "PeerConnected" : "PeerLeft", "", names.size());
                advert.put("players", String.valueOf(1 + names.size()));
                final String msg = joined ? "Un giocatore è entrato (" + (1 + names.size()) + "/4)" : "Un giocatore è uscito";
                main.post(() -> {
                    Toast.makeText(app, msg, Toast.LENGTH_SHORT).show();
                    if (listener != null) listener.onPlayersChanged(lastPlayers);
                });
            }
            try { Thread.sleep(700); } catch (InterruptedException e) { return; }
        }
    }

    private void fail(String message) {
        lastError = message;
        AppState.lastError = message;
        DsLink.log("[host] " + message);
        main.post(() -> { if (listener != null) listener.onError(message); });
    }

    void markGameStarted() { DsLink.smEvent(sm, "GameStarted", "", -1); }

    synchronized void stop() {
        if (!running && server == 0) return;
        running = false;
        if (poller != null) poller.interrupt();
        NetInfo.unwatch(app, netCb);
        discovery.stopAdvertising();
        if (server != 0) DsLink.hostStop(server);
        server = 0;
        if (sm != 0) {
            DsLink.smEvent(sm, "Stop", "", -1);
            DsLink.smFree(sm);
            sm = 0;
        }
        AppState.role = "";
        AppState.netplayState = "idle";
        if (current == this) current = null;
    }
}
