package com.dslink.emulator;

/** Pure helpers for file names / system-file detection (JVM unit-testable). */
final class Names {
    private Names() {}

    /** Chooses the canonical name from the size alone: bios7 16 KiB, bios9 4 KiB, firmware 128/256/512 KiB. */
    static String systemFileNameForSize(long size) {
        if (size == 0x4000) return "bios7.bin";
        if (size == 0x1000) return "bios9.bin";
        if (size == 0x20000 || size == 0x40000 || size == 0x80000) return "firmware.bin";
        return null;
    }

    static String safeName(String n) {
        String s = n == null ? "" : n.replaceAll("[^A-Za-z0-9._ \\-()]", "_");
        return s.isEmpty() ? "file" : s;
    }

    static boolean isValidIPv4(String s) {
        if (s == null || !s.matches("(\\d{1,3}\\.){3}\\d{1,3}")) return false;
        for (String p : s.split("\\.")) {
            if (p.length() > 1 && p.startsWith("0")) return false;
            if (Integer.parseInt(p) > 255) return false;
        }
        return true;
    }

    static boolean isValidPort(int p) {
        return p >= 1024 && p <= 65535;
    }
}
