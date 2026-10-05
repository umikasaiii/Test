package com.dslink.emulator;

import java.util.LinkedHashMap;
import java.util.Map;

/** "key=value\n" text codec shared with the native layer. Pure Java: unit-testable on the JVM. */
final class Kv {
    private Kv() {}

    static Map<String, String> parse(String text) {
        Map<String, String> m = new LinkedHashMap<>();
        if (text == null) return m;
        for (String line : text.split("\n")) {
            int eq = line.indexOf('=');
            if (eq > 0) m.put(line.substring(0, eq), line.substring(eq + 1));
        }
        return m;
    }

    static String encode(Map<String, String> m) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : m.entrySet()) {
            String v = e.getValue() == null ? "" : e.getValue().replace('\n', ' ').replace('\r', ' ');
            sb.append(e.getKey()).append('=').append(v).append('\n');
        }
        return sb.toString();
    }

    static int parseInt(String s, int def) {
        try {
            return Integer.parseInt(s);
        } catch (Exception e) {
            return def;
        }
    }
}
