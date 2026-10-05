package com.dslink.emulator;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;
import java.util.Map;

/** Host waiting room: publishes the room on the LAN and shows who joined. The game is launched from here. */
public class HostActivity extends Activity implements HostSession.Listener {
    private Storage storage;
    private String romPath, romTitle, romSha;
    private LinearLayout col;
    private TextView status, count, players, details;
    private boolean launched;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        storage = new Storage(this);
        romPath = getIntent().getStringExtra("path");
        romTitle = getIntent().getStringExtra("title");
        romSha = getIntent().getStringExtra("sha");
        col = Ui.page(this, romTitle == null ? "Partita" : romTitle, "Creazione stanza…");
        prepare();
    }

    private void prepare() {
        new Thread(() -> {
            Map<String, String> id = storage.identity();
            HostSession existing = HostSession.get();
            final String[] err = new String[1];
            final HostSession s = existing != null && existing.romSha.equals(romSha) ? existing
                    : HostSession.start(this, romTitle, romSha, id, "Stanza di " + id.get("player_name"), err);
            runOnUiThread(() -> {
                if (s == null) showError(err[0]);
                else show(s);
            });
        }).start();
    }

    private void showError(String msg) {
        col.removeAllViews();
        col.addView(Ui.text(this, "Impossibile creare la partita", 24, Ui.TEXT, true));
        col.addView(Ui.space(this, 12));
        col.addView(Ui.text(this, msg, 16, Ui.ERR, false));
        col.addView(Ui.space(this, 20));
        col.addView(Ui.button(this, "Riprova", true, v -> { col.removeAllViews(); prepare(); }));
        col.addView(Ui.button(this, "Indietro", false, v -> finish()));
    }

    private void show(final HostSession s) {
        col.removeAllViews();
        col.addView(Ui.text(this, romTitle, 30, Ui.TEXT, true));
        col.addView(Ui.text(this, s.advert.get("room"), 18, Ui.MUTED, false));
        col.addView(Ui.space(this, 20));

        LinearLayout card = Ui.card(this);
        status = Ui.text(this, "In attesa di giocatori…", 20, Ui.TEXT, true);
        count = Ui.text(this, "1/4", 34, Ui.ACCENT, true);
        players = Ui.text(this, "", 15, Ui.MUTED, false);
        card.addView(status);
        card.addView(count);
        card.addView(players);
        col.addView(card);

        if (NetInfo.vpnActive(this)) {
            col.addView(Ui.text(this, "Rilevata una VPN attiva: il multiplayer locale del DS non funziona attraverso VPN o tunnel. Disattivala.", 14, Ui.WARN, false));
            col.addView(Ui.space(this, 8));
        }

        details = Ui.text(this, "", 16, Ui.TEXT, false);
        details.setVisibility(View.GONE);
        col.addView(Ui.button(this, "Mostra dati connessione", false, v -> {
            details.setText("IP: " + s.advert.get("ip") + "\nPorta: " + s.advert.get("port"));
            details.setVisibility(details.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
        }));
        col.addView(details);

        col.addView(Ui.text(this,
                "Quando i giocatori sono entrati, tocca \"Avvia gioco\", poi nel gioco scegli Multiplayer.\n"
                        + "Gli altri telefoni entreranno con DS Download Play.", 13, Ui.MUTED, false));
        col.addView(Ui.space(this, 14));
        col.addView(Ui.button(this, "Avvia gioco", true, v -> startGame(s)));
        col.addView(Ui.button(this, "Termina stanza", false, v -> { s.stop(); finish(); }));
        s.setListener(this);
    }

    private void startGame(HostSession s) {
        GameLauncher.requestMicIfNeeded(this);
        s.markGameStarted();
        AppState.romLoaded = true;
        AppState.romSha = romSha;
        String err = GameLauncher.launch(this, storage, GameLauncher.Role.HOST, romPath, "", s.port);
        if (err != null) {
            new AlertDialog.Builder(this).setTitle("Errore").setMessage(err).setPositiveButton("OK", null).show();
            return;
        }
        launched = true;
    }

    @Override
    public void onPlayersChanged(List<String> nicks) {
        if (count == null) return;
        count.setText((1 + nicks.size()) + "/4");
        status.setText(nicks.isEmpty() ? "In attesa di giocatori…" : "Giocatori connessi");
        StringBuilder sb = new StringBuilder("Tu (host)");
        for (String n : nicks) sb.append("\n").append(n);
        players.setText(sb.toString());
    }

    @Override
    public void onError(String message) {
        if (status != null) {
            status.setText(message);
            status.setTextColor(Ui.ERR);
        }
    }

    @Override
    protected void onDestroy() {
        HostSession s = HostSession.get();
        if (s != null) s.setListener(null);
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        HostSession s = HostSession.get();
        if (s != null) s.stop();
        super.onBackPressed();
    }
}
