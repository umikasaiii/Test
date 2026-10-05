package com.dslink.emulator;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.Map;

/** Settings: player name, the user's own Nintendo DS system files, advanced + diagnostics. */
public class SettingsActivity extends Activity {
    private static final int REQ_SYSTEM = 21;
    private Storage storage;
    private LinearLayout col;
    private boolean advanced;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        storage = new Storage(this);
    }

    @Override
    protected void onResume() {
        super.onResume();
        build();
    }

    private void build() {
        col = Ui.page(this, "Impostazioni", null);
        Map<String, String> id = storage.identity();

        col.addView(Ui.section(this, "Giocatore"));
        LinearLayout nameCard = Ui.card(this);
        nameCard.addView(Ui.text(this, id.get("player_name"), 22, Ui.TEXT, true));
        nameCard.addView(Ui.text(this, "Questo nome compare nelle stanze che crei.", 13, Ui.MUTED, false));
        col.addView(nameCard);
        col.addView(Ui.button(this, "Cambia nome", false, v -> renameDialog(id.get("player_name"))));

        col.addView(Ui.section(this, "File di sistema Nintendo DS"));
        Map<String, String> st = storage.systemStatus();
        LinearLayout card = Ui.card(this);
        for (String k : new String[]{"bios7", "bios9", "firmware"}) {
            boolean ok = "OK".equals(st.get(k));
            TextView t = Ui.text(this, (ok ? "✓ " : "✗ ") + k + ".bin", 17, ok ? Ui.OK : Ui.MUTED, false);
            card.addView(t);
            if (!ok && st.get(k + "_msg") != null && !"MISSING".equals(st.get(k)))
                card.addView(Ui.text(this, st.get(k + "_msg"), 12, Ui.WARN, false));
        }
        card.addView(Ui.space(this, 8));
        card.addView(Ui.text(this,
                "I file devono provenire dal tuo Nintendo DS. Restano solo su questo dispositivo e non vengono mai inviati altrove. "
                        + "Servono per entrare nelle partite con DS Download Play.", 13, Ui.MUTED, false));
        col.addView(card);
        col.addView(Ui.button(this, "Importa file di sistema", false, v -> pickSystemFiles()));

        col.addView(Ui.section(this, "Avanzate"));
        col.addView(Ui.button(this, advanced ? "Nascondi opzioni avanzate" : "Mostra opzioni avanzate", false, v -> {
            advanced = !advanced;
            build();
        }));
        if (advanced) {
            LinearLayout adv = Ui.card(this);
            adv.addView(Ui.text(this, "DSLink " + AppInfo.APP_VERSION, 14, Ui.TEXT, false));
            adv.addView(Ui.text(this, AppInfo.RETROARCH_VERSION + " · " + AppInfo.CORE_VERSION, 14, Ui.MUTED, false));
            adv.addView(Ui.text(this, "Rete: solo LAN. Nessun server, account o telemetria.", 13, Ui.MUTED, false));
            col.addView(adv);
            col.addView(Ui.button(this, "Diagnostica multiplayer", false,
                    v -> startActivity(new Intent(this, DiagnosticsActivity.class))));
        }
        col.addView(Ui.section(this, "Informazioni"));
        col.addView(Ui.text(this,
                "DSLink è software libero (GPLv3) basato su RetroArch e melonDS DS. Non include ROM, BIOS o firmware Nintendo.",
                12, Ui.MUTED, false));
    }

    private void renameDialog(String current) {
        final EditText e = new EditText(this);
        e.setText(current);
        e.setSelectAllOnFocus(true);
        new AlertDialog.Builder(this).setTitle("Nome giocatore").setView(e)
                .setPositiveButton("Salva", (d, w) -> {
                    String n = e.getText().toString().trim();
                    if (DsLink.identityRename(storage.identityFile().getAbsolutePath(), n) == null)
                        new AlertDialog.Builder(this).setMessage("Il nome deve avere da 1 a 24 caratteri.").setPositiveButton("OK", null).show();
                    build();
                })
                .setNegativeButton("Annulla", null).show();
    }

    private void pickSystemFiles() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(i, REQ_SYSTEM);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_SYSTEM || res != RESULT_OK || data == null) return;
        final java.util.List<Uri> uris = new java.util.ArrayList<>();
        if (data.getClipData() != null)
            for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
        else if (data.getData() != null) uris.add(data.getData());
        new Thread(() -> {
            final StringBuilder sb = new StringBuilder();
            for (Uri u : uris) sb.append(storage.importSystemFile(u)).append('\n');
            runOnUiThread(() -> {
                new AlertDialog.Builder(this).setTitle("Importazione").setMessage(sb.toString().trim())
                        .setPositiveButton("OK", null).show();
                build();
            });
        }).start();
    }
}
