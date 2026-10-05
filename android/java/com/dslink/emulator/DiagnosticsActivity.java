package com.dslink.emulator;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.widget.TextView;
import android.widget.Toast;

import java.util.LinkedHashMap;
import java.util.Map;

/** Settings -> Diagnostics: everything needed to debug a failed multiplayer session; log is privacy-scrubbed. */
public class DiagnosticsActivity extends Activity {
    private Storage storage;
    private TextView body;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        storage = new Storage(this);
        android.widget.LinearLayout col = Ui.page(this, "Diagnostica", "Multiplayer");
        body = Ui.text(this, "", 12, Ui.TEXT, false);
        body.setTypeface(android.graphics.Typeface.MONOSPACE);
        body.setTextIsSelectable(true);
        col.addView(body);
        col.addView(Ui.space(this, 12));
        col.addView(Ui.button(this, "Copia log", true, v -> {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("DSLink diagnostica", body.getText()));
            Toast.makeText(this, "Copiato", Toast.LENGTH_SHORT).show();
        }));
        col.addView(Ui.button(this, "Aggiorna", false, v -> refresh()));
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    private void refresh() {
        Map<String, String> id = storage.identity();
        NetInfo.Lan lan = NetInfo.lan();
        Map<String, String> r = new LinkedHashMap<>();
        r.put("platform", "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
        r.put("dslink_version", AppInfo.APP_VERSION);
        r.put("retroarch_version", AppInfo.RETROARCH_VERSION);
        r.put("core_version", AppInfo.CORE_VERSION);
        r.put("player_id", id.get("device_id"));
        r.put("mac", id.get("mac"));
        r.put("ipv4", lan.found ? lan.ip : "");
        r.put("subnet", lan.subnet());
        r.put("connection_type", lan.found ? NetInfo.kindLabel(lan.kind) + (lan.vpn ? " (VPN attiva)" : "") : "nessuna rete");
        r.put("role", AppState.role);
        r.put("remote_ip", AppState.remoteIp);
        r.put("port", AppState.port);
        r.put("discovery", AppState.discovery);
        r.put("netplay", AppState.netplayState);
        r.put("ping", AppState.ping);
        r.put("jitter", AppState.jitter);
        r.put("last_error", AppState.lastError);
        r.put("firmware", storage.systemReady() ? "1" : "0");
        r.put("rom_loaded", AppState.romLoaded ? "1" : "0");
        r.put("rom_sha256", AppState.romSha);
        body.setText(DsLink.diagnostics(DsLink.encode(r)));
    }
}
