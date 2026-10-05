package com.dslink.emulator;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.res.AssetManager;
import android.content.res.Configuration;
import android.os.Build;
import android.provider.Settings;

import com.retroarch.browser.mainmenu.MainMenuActivity;
import com.retroarch.browser.retroactivity.RetroActivityFuture;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.LinkedHashMap;
import java.util.Map;

/** Writes the RetroArch / core configuration for a session and starts the emulator activity. */
final class GameLauncher {
    private GameLauncher() {}

    enum Role { SINGLE, HOST, CLIENT }

    /** Copies bundled assets (touch overlay, core info) into private storage when the app version changed. */
    static void prepareAssets(Activity a, Storage st) {
        File marker = new File(st.base(), "assets.version");
        String want = AppInfo.APP_VERSION + "/" + a.getApplicationInfo().sourceDir.hashCode();
        try {
            if (marker.exists() && new String(java.nio.file.Files.readAllBytes(marker.toPath())).equals(want)) return;
        } catch (Exception ignored) {
        }
        copyAssetDir(a.getAssets(), "overlay", st.overlayDir());
        copyAssetDir(a.getAssets(), "info", st.infoDir());
        try (OutputStream o = new FileOutputStream(marker)) {
            o.write(want.getBytes());
        } catch (Exception ignored) {
        }
    }

    private static void copyAssetDir(AssetManager am, String dir, File dest) {
        try {
            String[] names = am.list(dir);
            if (names == null) return;
            //noinspection ResultOfMethodCallIgnored
            dest.mkdirs();
            for (String n : names) {
                try (InputStream in = am.open(dir + "/" + n); OutputStream out = new FileOutputStream(new File(dest, n))) {
                    byte[] buf = new byte[1 << 14];
                    int r;
                    while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
                }
            }
        } catch (Exception e) {
            DsLink.log("asset copy failed for " + dir + ": " + e.getClass().getSimpleName());
        }
    }

    private static void write(File f, String text) throws java.io.IOException {
        try (OutputStream o = new FileOutputStream(f)) {
            o.write(text.getBytes("UTF-8"));
        }
    }

    /**
     * Starts RetroArch. 'contentPath' is empty for a Download Play client (DS boots with no cartridge).
     * Returns null on success or a user-facing error message.
     */
    static String launch(Activity a, Storage st, Role role, String contentPath, String hostIp, int port) {
        try {
            prepareAssets(a, st);
            Map<String, String> id = st.identity();
            Map<String, String> plan = new LinkedHashMap<>();
            plan.put("role", role == Role.CLIENT ? "client" : "host");
            plan.put("mode", "download-play");
            plan.put("content", contentPath == null ? "" : contentPath);
            plan.put("core_path", st.corePath());
            plan.put("system_dir", st.systemRoot().getAbsolutePath());
            plan.put("save_dir", st.savesDir().getAbsolutePath());
            plan.put("state_dir", st.statesDir().getAbsolutePath());
            plan.put("config_dir", st.configDir().getAbsolutePath());
            plan.put("info_dir", st.infoDir().getAbsolutePath());
            File overlay = new File(st.overlayDir(), "dslink.cfg");
            if (overlay.exists()) plan.put("overlay", overlay.getAbsolutePath());
            plan.put("device_id", id.get("device_id"));
            plan.put("player_name", id.get("player_name"));
            plan.put("nick_salt", id.get("nick_salt"));
            plan.put("host_ip", hostIp == null ? "" : hostIp);
            plan.put("port", String.valueOf(port));
            plan.put("landscape", a.getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE ? "1" : "0");
            String kv = DsLink.encode(plan);

            String cfg = DsLink.launchConfig(kv);
            String opts = DsLink.launchCoreOptions(kv);
            if (cfg == null || opts == null) return "Configurazione non valida (" + DsLink.lastError() + ").";
            write(st.retroarchCfg(), cfg);
            write(st.coreOptions(), opts);
            if (!new File(st.corePath()).exists()) return "Il core melonDS DS non è presente nell'app (build incompleta).";

            Intent retro = new Intent(a, RetroActivityFuture.class);
            retro.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
            MainMenuActivity.PACKAGE_NAME = a.getPackageName();
            MainMenuActivity.startRetroActivity(
                    retro,
                    contentPath == null || contentPath.isEmpty() ? null : contentPath,
                    st.corePath(),
                    st.retroarchCfg().getAbsolutePath(),
                    Settings.Secure.getString(a.getContentResolver(), Settings.Secure.DEFAULT_INPUT_METHOD),
                    a.getApplicationInfo().dataDir,
                    a.getApplicationInfo().sourceDir);
            if (role != Role.SINGLE) retro.putExtra("DSLINK_NETPLAY", DsLink.launchNetplayExtra(kv));
            DsLink.log("[launch] " + role + " content=" + (contentPath == null || contentPath.isEmpty() ? "none" : "rom") + " port=" + port);
            a.startActivity(retro);
            return null;
        } catch (Exception e) {
            DsLink.log("[launch] failed: " + e);
            return "Impossibile avviare l'emulatore (" + e.getClass().getSimpleName() + ").";
        }
    }

    /** The microphone is only needed by a few games; ask once, never block on it. */
    static void requestMicIfNeeded(Activity a) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                a.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            a.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 77);
        }
    }
}
