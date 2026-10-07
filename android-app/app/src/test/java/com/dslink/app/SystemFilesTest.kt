package com.dslink.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File

/** FILE DI SISTEMA: four separate slots, their pickers, the content validation of refs.json and what survives a restart. No private content: the refs here are made-up bits. */
class SystemFilesTest {
    private fun hash() = "01".repeat(128)
    private fun refsJson(len: Int = 256, extra: String = ""): String {
        val h = "01".repeat(128).take(len)
        return listOf("host_main_menu", "host_find_players", "client_ds_menu", "client_dl_open", "client_discovered").joinToString(",", "{", "$extra}") { "\"$it\":{\"top\":\"$h\",\"bot\":\"$h\"}" }
    }
    private fun tmp(): File = java.nio.file.Files.createTempDirectory("sysfiles").toFile().also { it.deleteOnExit() }
    private fun input(s: String) = ByteArrayInputStream(s.toByteArray())
    private val always: (File) -> String? = { null }

    @Test fun fourSystemFileSlotsAreSeparate() {
        val s = SysFiles.SLOTS
        assertEquals(listOf("bios7.bin", "bios9.bin", "firmware.bin", "refs.json"), s.map { it.file })
        assertEquals(listOf(0, 1, 2, 3), s.map { it.kind })
        assertEquals(4, s.map { it.file }.toSet().size)
        assertEquals(SysFiles.REFS_KIND, SysFiles.slot(3)!!.kind)
        // importing refs.json never touches firmware.bin (or the BIOS files), and the other way round
        val store = SysFileStore(tmp())
        assertNull(store.import(s[2], "firmware.bin", input("FIRMWARE"), always))
        assertNull(store.import(s[3], "refs.json", input(refsJson()), { RefsCheck.validate(it.readText()) }))
        assertEquals("FIRMWARE", store.file(s[2]).readText())
        assertTrue(store.file(s[3]).readText().startsWith("{\"host_main_menu\""))
        assertFalse(store.has(s[0])); assertFalse(store.has(s[1]))
    }

    @Test fun refsPickerAcceptsJsonTypesAndTheOtherRowsAcceptAnything() {
        val refs = SysFiles.slot(SysFiles.REFS_KIND)!!
        for (m in listOf("application/json", "text/json", "application/octet-stream")) assertTrue("refs picker must offer $m", refs.mimes.contains(m))
        assertTrue(refs.mimes.contains("text/plain"))   // many phone editors label a .json file text/plain
        assertFalse("the refs picker is not limited to .bin/.nds types", refs.mimes.any { it.contains("nintendo") || it == "application/x-nintendo-ds-rom" })
        for (k in 0..2) assertArrayEquals(arrayOf("*/*"), SysFiles.slot(k)!!.mimes)   // BIOS/firmware have no reliable MIME on phones
    }

    @Test fun genericMimeFallbackExistsOnlyAsAnExplicitChoice() {
        assertArrayEquals(arrayOf("*/*"), SysFiles.ANY_MIME)
        assertFalse(SysFiles.slot(SysFiles.REFS_KIND)!!.mimes.contains("*/*"))   // the first picker shows JSON-like files; "show all files" is a second, explicit button
        // a file whose MIME the file manager got wrong is still judged by its CONTENT after the pick
        assertNull(RefsCheck.validate(refsJson()))
        assertNotNull(RefsCheck.validate("this is not json"))
    }

    @Test fun refsValidationChecksTheContentNotTheName() {
        assertNull(RefsCheck.validate(refsJson()))
        assertNull(RefsCheck.validate("﻿" + refsJson() + "\n"))                      // byte-order mark and newline from a text editor
        assertNull(RefsCheck.validate(refsJson(extra = ",\"client_lobby\":{\"top\":\"${hash()}\",\"bot\":\"${hash()}\"}")))   // more screens than the required five are fine
        assertNotNull(RefsCheck.validate(refsJson(len = 192)))                            // the old, wrong length
        assertNotNull(RefsCheck.validate(refsJson().replace("01", "0x", ignoreCase = false).take(200)))
        assertNotNull(RefsCheck.validate("{}"))
        assertNotNull(RefsCheck.validate(""))
        assertNotNull(RefsCheck.validate("[1,2,3]"))
        assertNotNull(RefsCheck.validate(refsJson().replace("client_dl_open", "x")))      // a required screen is missing
        // verdicts and messages never carry file content
        for (bad in listOf(refsJson(len = 192), "{}", "nope")) {
            val m = RefsCheck.validate(bad)!!
            assertFalse(Regex("[01]{20,}").containsMatchIn(m))
            assertTrue(RefsCheck.verdict(m).startsWith("refs.json non valido"))
        }
        assertEquals("refs.json importato", RefsCheck.verdict(null))
    }

    @Test fun refsImportKeepsWhatWasThereWhenTheNewFileIsInvalid() {
        val slot = SysFiles.slot(SysFiles.REFS_KIND)!!
        val store = SysFileStore(tmp())
        assertNull(store.import(slot, "good.json", input(refsJson()), { RefsCheck.validate(it.readText()) }))
        val before = store.file(slot).readText()
        val why = store.import(slot, "bad.json", input("{}"), { RefsCheck.validate(it.readText()) })
        assertNotNull(why)
        assertEquals(before, store.file(slot).readText())
        assertEquals("good.json", store.displayName(slot))
        assertFalse(File(store.file(slot).parentFile, "refs.json.part").exists())
    }

    @Test fun refsSurviveARestart() {
        val dir = tmp()
        val slot = SysFiles.slot(SysFiles.REFS_KIND)!!
        assertNull(SysFileStore(dir).import(slot, "I miei riferimenti.json", input(refsJson()), { RefsCheck.validate(it.readText()) }))
        val reopened = SysFileStore(dir)   // a new process: only the private copy and its sidecar exist
        assertTrue(reopened.has(slot))
        assertEquals("I miei riferimenti.json", reopened.displayName(slot))
        assertNull(RefsCheck.validate(reopened.file(slot).readText()))
        assertEquals(File(dir, "refs.json").path, reopened.file(slot).path)   // the path the gateway is given (DSLINK_PROFILE_REFS)
    }
}
