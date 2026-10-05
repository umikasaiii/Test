package com.dslink.emulator;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.LinkedHashMap;
import java.util.Map;

public class PureJavaTest {
    @Test
    public void kvRoundTrip() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("a", "1");
        m.put("room", "Stanza di Simone");
        Map<String, String> back = Kv.parse(Kv.encode(m));
        assertEquals(m, back);
    }

    @Test
    public void kvEncodeStripsNewlines() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("k", "a\nb\rc");
        assertEquals("k=a b c\n", Kv.encode(m));
    }

    @Test
    public void kvParseIgnoresGarbageAndNull() {
        assertTrue(Kv.parse(null).isEmpty());
        assertEquals(1, Kv.parse("noequals\nx=y\n").size());
        assertEquals(7, Kv.parseInt("x", 7));
    }

    @Test
    public void systemFileDetectionBySize() {
        assertEquals("bios7.bin", Names.systemFileNameForSize(16384));
        assertEquals("bios9.bin", Names.systemFileNameForSize(4096));
        assertEquals("firmware.bin", Names.systemFileNameForSize(131072));
        assertEquals("firmware.bin", Names.systemFileNameForSize(262144));
        assertEquals("firmware.bin", Names.systemFileNameForSize(524288));
        assertNull(Names.systemFileNameForSize(12345));
    }

    @Test
    public void safeNameRemovesPathTricks() {
        assertEquals(".._.._etc_passwd", Names.safeName("../../etc/passwd").replace("/", "_"));
        assertFalse(Names.safeName("a/b\\c").contains("/"));
        assertEquals("file", Names.safeName(""));
    }

    @Test
    public void manualConnectionValidation() {
        assertTrue(Names.isValidIPv4("192.168.1.20"));
        assertFalse(Names.isValidIPv4("192.168.1"));
        assertFalse(Names.isValidIPv4("256.1.1.1"));
        assertFalse(Names.isValidIPv4("01.2.3.4"));
        assertFalse(Names.isValidIPv4(null));
        assertTrue(Names.isValidPort(55435));
        assertFalse(Names.isValidPort(80));
        assertFalse(Names.isValidPort(70000));
    }
}
