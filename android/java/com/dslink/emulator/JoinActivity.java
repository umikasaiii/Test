package com.dslink.emulator;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.text.InputType;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Client: finds nearby rooms (mDNS + beacon), runs the DSLink handshake (compatibility + MAC check), measures the
 * link, waits for the host's emulator and finally boots the DS with no cartridge so it can use DS Download Play.
 */
public class JoinActivity extends Activity implements Discovery.Listener {
    private Storage storage;
    private Discovery discovery;
    private LinearLayout col, list;
    private TextView stateText;
    private volatile boolean cancelled;
    private String joinedIp = "";
    private int joinedPort;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        storage = new Storage(this);
        discovery = new Discovery(this);
        AppState.role = "client";
    }

    @Override
    protected void onResume() {
        super.onResume();
        cancelled = false;
        if (!joinedIp.isEmpty()) {  // came back from the emulator
            DsLink.bye(joinedIp, joinedPort, storage.identity().get("device_id"));
            joinedIp = "";
        }
        buildList();
        NetInfo.Lan lan = NetInfo.lan();
        if (!lan.found) {
            stateText.setText(NetInfo.wifiEnabled(this) ? "Non sei connesso a una rete locale." : "Il Wi-Fi è disattivato.");
            stateText.setTextColor(Ui.ERR);
            return;
        }
        AppState.discovery = "searching";
        discovery.startBrowsing(this);
    }

    @Override
    protected void onPause() {
        super.onPause();
        cancelled = true;
        discovery.stopBrowsing();
        AppState.discovery = "idle";
    }

    private void buildList() {
        col = Ui.page(this, "Unisciti", "Partite vicine");
        stateText = Ui.text(this, "Ricerca in corso…", 15, Ui.MUTED, false);
        col.addView(stateText);
        col.addView(Ui.section(this, "Partite vicine"));
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        col.addView(list);
        col.addView(Ui.section(this, "Non la trovi?"));
        col.addView(Ui.button(this, "Inserisci IP manualmente", false, v -> manualDialog()));
        col.addView(Ui.text(this,
                "Controlla che entrambi i telefoni siano sulla stessa rete Wi-Fi (non \"ospiti\") o che uno usi l'hotspot dell'altro.",
                13, Ui.MUTED, false));
    }

    @Override
    public void onRoomsChanged(List<Discovery.Room> rooms) {
        if (list == null) return;
        list.removeAllViews();
        if (rooms.isEmpty()) {
            stateText.setText("Ricerca in corso…");
            return;
        }
        stateText.setText(rooms.size() == 1 ? "1 partita trovata" : rooms.size() + " partite trovate");
        for (final Discovery.Room r : rooms) {
            LinearLayout card = Ui.card(this);
            card.addView(Ui.text(this, r.game.isEmpty() ? "Nintendo DS" : r.game, 20, Ui.TEXT, true));
            card.addView(Ui.text(this, r.name, 15, Ui.MUTED, false));
            card.addView(Ui.text(this, r.players + "/" + r.max + " giocatori", 13, Ui.MUTED, false));
            card.addView(Ui.space(this, 8));
            card.addView(Ui.button(this, "ENTRA", true, v -> join(r.ip, r.port)));
            list.addView(card);
        }
    }

    private void manualDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int p = Ui.dp(this, 20);
        box.setPadding(p, p, p, 0);
        final EditText ip = new EditText(this);
        ip.setHint("IP (es. 192.168.1.20)");
        ip.setInputType(InputType.TYPE_CLASS_PHONE);
        final EditText port = new EditText(this);
        port.setHint("Porta");
        port.setText(String.valueOf(AppInfo.DEFAULT_PORT));
        port.setInputType(InputType.TYPE_CLASS_NUMBER);
        box.addView(ip);
        box.addView(port);
        new AlertDialog.Builder(this).setTitle("Connessione manuale").setView(box)
                .setPositiveButton("Connetti", (d, w) -> {
                    String addr = ip.getText().toString().trim();
                    int pt = DsLink.parseInt(port.getText().toString().trim(), 0);
                    if (!addr.matches("(\\d{1,3}\\.){3}\\d{1,3}") || pt < 1024 || pt > 65535) {
                        info("Dati non validi", "Inserisci un indirizzo IPv4 valido e una porta tra 1024 e 65535.");
                        return;
                    }
                    join(addr, pt);
                })
                .setNegativeButton("Annulla", null).show();
    }

    private void info(String title, String msg) {
        new AlertDialog.Builder(this).setTitle(title).setMessage(msg).setPositiveButton("OK", null).show();
    }

    // ---- join sequence ------------------------------------------------------------------------------------

    private void join(final String ip, final int port) {
        if (!storage.systemReady()) {
            new AlertDialog.Builder(this).setTitle("File di sistema mancanti")
                    .setMessage("Per usare DS Download Play serve il firmware del tuo Nintendo DS (bios7.bin, bios9.bin, firmware.bin).\nImportali da Impostazioni → File di sistema Nintendo DS.")
                    .setPositiveButton("Apri Impostazioni", (d, w) -> startActivity(new android.content.Intent(this, SettingsActivity.class)))
                    .setNegativeButton("Annulla", null).show();
            return;
        }
        discovery.stopBrowsing();
        col.removeAllViews();
        col.addView(Ui.text(this, "Connessione…", 28, Ui.TEXT, true));
        final TextView step = Ui.text(this, "Controllo della stanza", 16, Ui.MUTED, false);
        col.addView(step);
        col.addView(Ui.space(this, 20));
        col.addView(Ui.button(this, "Annulla", false, v -> { cancelled = true; finish(); }));
        new Thread(() -> runJoin(ip, port, step), "dslink-join").start();
    }

    private void ui(final TextView t, final String s) {
        runOnUiThread(() -> t.setText(s));
    }

    private void fail(final String title, final String msg) {
        AppState.lastError = title + ": " + msg;
        AppState.netplayState = "failed";
        DsLink.log("[client] " + title + " - " + msg.replace('\n', ' '));
        runOnUiThread(() -> new AlertDialog.Builder(this).setTitle(title).setMessage(msg)
                .setPositiveButton("OK", (d, w) -> recreate()).show());
    }

    private void runJoin(String ip, int port, TextView step) {
        long sm = DsLink.smNew();
        try {
            DsLink.smEvent(sm, "StartJoin", "", -1);
            DsLink.smEvent(sm, "Prepared", "", -1);
            DsLink.smEvent(sm, "RoomSelected", ip + ":" + port, -1);
            AppState.remoteIp = ip;
            AppState.port = String.valueOf(port);
            AppState.netplayState = "joining";

            if (NetInfo.vpnActive(this)) DsLink.log("[client] VPN detected");

            // 1. DSLink handshake: compatibility, MAC conflicts.
            Map<String, String> res = null;
            for (int attempt = 0; attempt < 3; attempt++) {
                Map<String, String> id = storage.identity();
                Map<String, String> me = new LinkedHashMap<>();
                me.put("proto", String.valueOf(AppInfo.PROTOCOL_VERSION));
                me.put("app", AppInfo.APP_VERSION);
                me.put("core", AppInfo.CORE_VERSION);
                me.put("console", "nds");
                me.put("mode", "download-play");
                me.put("device", id.get("device_id"));
                me.put("nick", id.get("nick"));
                res = DsLink.kv(DsLink.hello(ip, port, DsLink.encode(me), id.get("mac")));
                if ("MAC_CONFLICT".equals(res.get("code"))) {  // regenerate our identity and retry transparently
                    DsLink.identityBumpSalt(storage.identityFile().getAbsolutePath());
                    continue;
                }
                break;
            }
            if (res == null || !"1".equals(res.get("ok"))) {
                DsLink.smEvent(sm, "Fail", res == null ? "no answer" : res.get("code"), -1);
                String msg = res != null && res.get("message") != null && !res.get("message").isEmpty()
                        ? res.get("message") : "Impossibile connettersi alla stanza.";
                fail(res != null && "1".equals(res.get("reachable")) ? "Impossibile entrare" : "Host non raggiungibile",
                        msg + (res != null && "1".equals(res.get("reachable")) ? "" : "\n\nSe il problema continua prova l'hotspot di uno dei due telefoni."));
                return;
            }
            if (cancelled) return;

            // 2. Link quality.
            ui(step, "Test rete…");
            Map<String, String> q = DsLink.kv(DsLink.probe(ip, port, 20));
            AppState.ping = q.get("avg_ms") + " ms";
            AppState.jitter = q.get("jitter_ms") + " ms";
            final String quality = q.get("quality");
            final String line = "Ping LAN: " + q.get("avg_ms") + " ms\nQualità: " + q.get("quality_label");
            ui(step, line);
            if ("INSUFFICIENT".equals(quality)) {
                final boolean[] go = new boolean[1];
                final Object lock = new Object();
                runOnUiThread(() -> new AlertDialog.Builder(this).setTitle("Rete insufficiente")
                        .setMessage(line + "\n\nIl Nintendo DS richiede una rete locale molto veloce e stabile. Il gioco potrebbe non funzionare.\nAvvicinati al router oppure usa l'hotspot di uno dei due telefoni.")
                        .setPositiveButton("Continua comunque", (d, w) -> { go[0] = true; synchronized (lock) { lock.notify(); } })
                        .setNegativeButton("Annulla", (d, w) -> { synchronized (lock) { lock.notify(); } })
                        .setCancelable(false).show());
                synchronized (lock) { try { lock.wait(); } catch (InterruptedException ignored) {} }
                if (!go[0]) { DsLink.smEvent(sm, "Stop", "", -1); runOnUiThread(this::finish); return; }
            } else {
                try { Thread.sleep(900); } catch (InterruptedException ignored) {}
            }

            // 3. Wait for the host's emulator (its Netplay TCP port only opens when the host starts the game).
            ui(step, "In attesa che l'host avvii il gioco…");
            boolean up = false;
            for (int i = 0; i < 180 && !cancelled; i++) {
                if (tcpOpen(ip, port)) { up = true; break; }
                try { Thread.sleep(500); } catch (InterruptedException ignored) {}
            }
            if (cancelled) { DsLink.smEvent(sm, "Stop", "", -1); return; }
            if (!up) {
                DsLink.smEvent(sm, "Fail", "host never started", -1);
                fail("Host non pronto", "L'host non ha avviato il gioco entro 90 secondi. Riprova quando è pronto.");
                return;
            }

            // 4. Boot the DS with no cartridge -> DS Download Play.
            DsLink.smEvent(sm, "NetplayConnected", "", -1);
            DsLink.smEvent(sm, "BootDS", "", -1);
            AppState.netplayState = "connected";
            joinedIp = ip;
            joinedPort = port;
            runOnUiThread(() -> {
                GameLauncher.requestMicIfNeeded(this);
                new AlertDialog.Builder(this).setTitle("Quasi fatto")
                        .setMessage("Si aprirà il menu del Nintendo DS.\nTocca \"DS Download Play\" e scegli il gioco dell'host.")
                        .setPositiveButton("OK", (d, w) -> {
                            String err = GameLauncher.launch(this, storage, GameLauncher.Role.CLIENT, "", ip, port);
                            if (err != null) fail("Errore", err);
                        })
                        .setCancelable(false).show();
            });
        } finally {
            DsLink.smFree(sm);
        }
    }

    private static boolean tcpOpen(String ip, int port) {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(ip, port), 400);
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
