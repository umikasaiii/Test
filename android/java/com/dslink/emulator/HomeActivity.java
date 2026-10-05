package com.dslink.emulator;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.List;
import java.util.Map;

/** Home: open a game, create / join a multiplayer room, settings, recent games. */
public class HomeActivity extends Activity {
    private static final int REQ_PICK_ROM = 1;
    private Storage storage;
    private LinearLayout col;
    private String pendingAction = "play";  // what to do once a ROM has been picked

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        storage = new Storage(this);
        DsLink.log("[app] DSLink " + AppInfo.APP_VERSION + " on Android " + android.os.Build.VERSION.RELEASE);
    }

    @Override
    protected void onResume() {
        super.onResume();
        build();
    }

    private void build() {
        col = Ui.page(this, "DSLink", "Nintendo DS");
        Storage.Game current = storage.recentGames().isEmpty() ? null : storage.recentGames().get(0);

        col.addView(Ui.button(this, "Apri gioco", true, v -> pickRom("play")));

        col.addView(Ui.section(this, "Multiplayer"));
        col.addView(Ui.button(this, "Crea partita", false, v -> {
            if (current == null) pickRom("host");
            else startHost(current);
        }));
        col.addView(Ui.button(this, "Unisciti", false, v -> startActivity(new Intent(this, JoinActivity.class))));
        if (current != null) {
            TextView hint = Ui.text(this, "Gioco per \"Crea partita\": " + current.title, 13, Ui.MUTED, false);
            col.addView(hint);
        }

        List<Storage.Game> recent = storage.recentGames();
        if (!recent.isEmpty()) {
            col.addView(Ui.section(this, "Ultimi giochi"));
            for (final Storage.Game g : recent) {
                col.addView(Ui.button(this, g.title, false, v -> gameMenu(g)));
            }
        }

        col.addView(Ui.section(this, " "));
        col.addView(Ui.button(this, "Impostazioni", false, v -> startActivity(new Intent(this, SettingsActivity.class))));
    }

    private void pickRom(String action) {
        pendingAction = action;
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        startActivityForResult(i, REQ_PICK_ROM);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_PICK_ROM || res != RESULT_OK || data == null || data.getData() == null) return;
        final Uri uri = data.getData();
        Toast.makeText(this, "Importazione in corso…", Toast.LENGTH_SHORT).show();
        final String action = pendingAction;
        new Thread(() -> {
            final String[] err = new String[1];
            final Storage.Game g = storage.importRom(uri, err);
            runOnUiThread(() -> {
                if (g == null) {
                    new AlertDialog.Builder(this).setTitle("ROM non valida").setMessage(err[0]).setPositiveButton("OK", null).show();
                    return;
                }
                build();
                if (action.equals("host")) startHost(g);
                else play(g);
            });
        }).start();
    }

    private void gameMenu(final Storage.Game g) {
        new AlertDialog.Builder(this)
                .setTitle(g.title)
                .setItems(new String[]{"Gioca", "Crea partita"}, (d, which) -> {
                    if (which == 0) play(g);
                    else startHost(g);
                })
                .show();
    }

    private void play(Storage.Game g) {
        storage.addRecent(g);
        GameLauncher.requestMicIfNeeded(this);
        AppState.romLoaded = true;
        AppState.romSha = g.sha256;
        String err = GameLauncher.launch(this, storage, GameLauncher.Role.SINGLE, g.path, "", AppInfo.DEFAULT_PORT);
        if (err != null) new AlertDialog.Builder(this).setTitle("Errore").setMessage(err).setPositiveButton("OK", null).show();
    }

    private void startHost(Storage.Game g) {
        storage.addRecent(g);
        Intent i = new Intent(this, HostActivity.class);
        i.putExtra("path", g.path);
        i.putExtra("title", g.title);
        i.putExtra("sha", g.sha256);
        startActivity(i);
    }
}
