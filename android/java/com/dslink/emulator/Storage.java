package com.dslink.emulator;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.database.Cursor;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** All files live in the app's private storage: ROMs, system files and saves never leave the device. */
final class Storage {
    private final Context ctx;
    private final File base;

    Storage(Context c) {
        ctx = c.getApplicationContext();
        base = new File(ctx.getFilesDir(), "dslink");
        for (String d : new String[]{"roms", "system/melonDS DS", "saves", "states", "config", "info", "overlay"})
            new File(base, d).mkdirs();
    }

    File base() { return base; }
    File identityFile() { return new File(base, "identity.txt"); }
    File systemRoot() { return new File(base, "system"); }
    File systemDir() { return new File(base, "system/melonDS DS"); }
    File savesDir() { return new File(base, "saves"); }
    File statesDir() { return new File(base, "states"); }
    File configDir() { return new File(base, "config"); }
    File infoDir() { return new File(base, "info"); }
    File overlayDir() { return new File(base, "overlay"); }
    File romsDir() { return new File(base, "roms"); }
    File retroarchCfg() { return new File(base, "retroarch.cfg"); }
    File coreOptions() { return new File(configDir(), "melondsds.opt"); }

    String corePath() {
        return ctx.getApplicationInfo().nativeLibraryDir + "/libmelondsds_libretro_android.so";
    }

    /** Display name + size of a SAF document. */
    static String displayName(Context c, Uri uri) {
        String name = null;
        try (Cursor cur = c.getContentResolver().query(uri, null, null, null, null)) {
            if (cur != null && cur.moveToFirst()) {
                int i = cur.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0) name = cur.getString(i);
            }
        } catch (Exception ignored) {
        }
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment() == null ? "file" : uri.getLastPathSegment();
        return name;
    }

    static String safeName(String n) {
        String s = n.replaceAll("[^A-Za-z0-9._ \\-()]", "_");
        return s.isEmpty() ? "file" : s;
    }

    /** Copies a SAF document into 'dest' (atomically via a temp file). Returns false on any I/O error. */
    boolean copyUri(Uri uri, File dest) {
        File tmp = new File(dest.getParentFile(), dest.getName() + ".part");
        try (InputStream in = ctx.getContentResolver().openInputStream(uri);
             OutputStream out = new FileOutputStream(tmp)) {
            if (in == null) return false;
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
        } catch (Exception e) {
            DsLink.log("copy failed: " + e.getClass().getSimpleName());
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            return false;
        }
        //noinspection ResultOfMethodCallIgnored
        dest.delete();
        return tmp.renameTo(dest);
    }

    // ---- recent games -------------------------------------------------------------------------------------

    static final class Game {
        String path, title, sha256;
    }

    private SharedPreferences prefs() { return ctx.getSharedPreferences("dslink", Context.MODE_PRIVATE); }

    List<Game> recentGames() {
        List<Game> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs().getString("recent", "[]"));
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                Game g = new Game();
                g.path = o.getString("path");
                g.title = o.optString("title", "");
                g.sha256 = o.optString("sha256", "");
                if (new File(g.path).exists()) out.add(g);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    void addRecent(Game g) {
        List<Game> all = recentGames();
        List<Game> next = new ArrayList<>();
        next.add(g);
        for (Game o : all) if (!o.path.equals(g.path) && next.size() < 8) next.add(o);
        JSONArray a = new JSONArray();
        try {
            for (Game o : next) {
                JSONObject j = new JSONObject();
                j.put("path", o.path);
                j.put("title", o.title);
                j.put("sha256", o.sha256);
                a.put(j);
            }
        } catch (Exception ignored) {
        }
        prefs().edit().putString("recent", a.toString()).apply();
    }

    Map<String, String> ndsInfo(String path) {
        return DsLink.kv(DsLink.ndsInfo(path));
    }

    /** Imports a ROM picked with the system file picker. Returns the Game or null (message in 'err[0]'). */
    Game importRom(Uri uri, String[] err) {
        String name = safeName(displayName(ctx, uri));
        if (!name.toLowerCase().endsWith(".nds")) {
            err[0] = "Seleziona un file .nds (ROM Nintendo DS).";
            return null;
        }
        File dest = new File(romsDir(), name);
        if (!copyUri(uri, dest)) {
            err[0] = "Impossibile copiare il file sul dispositivo (spazio insufficiente?).";
            return null;
        }
        Map<String, String> info = ndsInfo(dest.getAbsolutePath());
        if (!"OK".equals(info.get("status"))) {
            err[0] = info.containsKey("message") ? info.get("message") : "ROM non valida.";
            //noinspection ResultOfMethodCallIgnored
            dest.delete();
            return null;
        }
        Game g = new Game();
        g.path = dest.getAbsolutePath();
        g.title = info.get("title") == null || info.get("title").isEmpty() ? name : info.get("title");
        g.sha256 = info.get("sha256");
        addRecent(g);
        return g;
    }

    // ---- system files ---------------------------------------------------------------------------------------

    /** Chooses the canonical file name from the size alone (bios7 16 KiB, bios9 4 KiB, firmware 128/256/512 KiB). */
    static String systemFileNameForSize(long size) {
        if (size == 0x4000) return "bios7.bin";
        if (size == 0x1000) return "bios9.bin";
        if (size == 0x20000 || size == 0x40000 || size == 0x80000) return "firmware.bin";
        return null;
    }

    /** Imports one picked file; returns a human-readable result line. */
    String importSystemFile(Uri uri) {
        File tmp = new File(systemDir(), "import.tmp");
        if (!copyUri(uri, tmp)) return "Impossibile leggere " + displayName(ctx, uri);
        String target = systemFileNameForSize(tmp.length());
        if (target == null) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            return displayName(ctx, uri) + ": dimensione non valida, il file non proviene da un Nintendo DS.";
        }
        File dest = new File(systemDir(), target);
        //noinspection ResultOfMethodCallIgnored
        dest.delete();
        //noinspection ResultOfMethodCallIgnored
        tmp.renameTo(dest);
        Map<String, String> v = DsLink.kv(DsLink.validateSystemDir(systemDir().getAbsolutePath()));
        String key = target.substring(0, target.indexOf('.'));
        if ("OK".equals(v.get(key))) return target + " importato.";
        String msg = v.get(key + "_msg");
        //noinspection ResultOfMethodCallIgnored
        dest.delete();
        return msg == null ? target + " non valido." : msg;
    }

    Map<String, String> systemStatus() {
        Map<String, String> m = DsLink.kv(DsLink.validateSystemDir(systemDir().getAbsolutePath()));
        return m == null ? new HashMap<String, String>() : m;
    }

    boolean systemReady() {
        return "1".equals(systemStatus().get("ready"));
    }

    // ---- misc -----------------------------------------------------------------------------------------------

    String playerName(Map<String, String> identity) {
        return identity.get("player_name");
    }

    Map<String, String> identity() {
        Map<String, String> m = DsLink.kv(DsLink.identityLoadOrCreate(identityFile().getAbsolutePath()));
        return m;
    }
}
