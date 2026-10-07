package com.dslink.app

import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts

/**
 * The user's own files for the Download Play: bios7.bin, bios9.bin, firmware.bin and refs.json (the screen references of the assistant). Four rows, four separate pickers: each row has its
 * own file-picker launcher (Storage Access Framework), so the kind of the row that was tapped can never be confused with another one, not even if Android recreates this screen while the
 * picker is open. The picked file is copied into THIS app's private storage (the Runtime needs real paths), validated by its content (the BIOS/firmware by the same DSLink C++ code the
 * desktop tools use, refs.json by its structure) and never leaves the phone: not in the APK, not in the repository, not in any artifact, not in any log.
 */
class SystemFilesActivity : ComponentActivity() {
    private class Row(val slot: SysFiles.Slot, val status: TextView)
    private val rows = ArrayList<Row>()
    private lateinit var summary: TextView
    private lateinit var store: SysFileStore
    private val launchers = HashMap<String, ActivityResultLauncher<Array<String>>>()   // "<kind>" and "<kind>*" (show every file)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = SysFileStore(Stack.systemDir(this))
        // one launcher per row (and one more for the "all files" fallback of refs.json), registered here, before the screen is started, as the Activity Result API requires
        for (slot in SysFiles.SLOTS) {
            launchers[slot.kind.toString()] = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { import(slot, it) } }
            if (slot.kind == SysFiles.REFS_KIND) launchers[slot.kind.toString() + "*"] = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { import(slot, it) } }
        }
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(40, 90, 40, 40); setBackgroundColor(0xFF050912.toInt()) }
        fun text(s: String, sp: Float, c: Int = Color.WHITE, bold: Boolean = false) = TextView(this).apply {
            text = s; textSize = sp; setTextColor(c); if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD); setPadding(0, 8, 0, 8)
        }
        col.addView(text("File di sistema Nintendo DS", 22f, bold = true))
        col.addView(text("Servono per far partire il Nintendo DS e il Download Play. Scegli i tuoi file: restano solo su questo telefono, non vengono mai inviati né inclusi nell'app.", 14f, 0xFFAFC4E8.toInt()))
        for (slot in SysFiles.SLOTS) {
            val st = text("", 13f, 0xFFAFC4E8.toInt())
            val b = Button(this).apply { text = if (slot.kind == SysFiles.REFS_KIND) "SCEGLI refs.json" else "SCEGLI FILE"; minHeight = 150; setOnClickListener { launchers[slot.kind.toString()]!!.launch(slot.mimes) } }
            col.addView(text("${slot.title} (${slot.file})", 16f, bold = true)); col.addView(st); col.addView(b, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 12 })
            if (slot.kind == SysFiles.REFS_KIND) {   // some file managers label a .json file with a type that is not JSON: this row alone can show every file, the content is checked after the pick
                val any = Button(this).apply { text = "MOSTRA TUTTI I FILE"; minHeight = 120; setOnClickListener { launchers[slot.kind.toString() + "*"]!!.launch(SysFiles.ANY_MIME) } }
                col.addView(any, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 12 })
            }
            rows += Row(slot, st)
        }
        summary = text("", 15f, 0xFF6FE3A1.toInt(), true).apply { gravity = Gravity.CENTER }
        col.addView(summary)
        setContentView(ScrollView(this).apply { setBackgroundColor(0xFF050912.toInt()); addView(col) })
        refresh()
    }

    override fun onResume() { super.onResume(); refresh() }

    /** what each row shows is read from the private copies, so it is the same after the app was closed and reopened */
    private fun refresh() {
        var all = true
        for (r in rows) {
            val f = store.file(r.slot)
            val name = store.displayName(r.slot)?.let { " · $it" } ?: ""
            if (!f.exists()) { r.status.text = "Non presente"; all = false; continue }
            if (r.slot.kind == SysFiles.REFS_KIND) {   // the screen references of the Download Play assistant (a game's own, private): needed to start a known game such as Mario Party DS
                val msg = RefsCheck.validate(try { f.readText() } catch (_: Exception) { "" })
                r.status.text = if (msg == null) "✓ IMPORTATO / VALIDO$name" else RefsCheck.verdict(msg)
                if (msg != null) all = false
                continue
            }
            val res = Native.nativeCheckSysFile(r.slot.kind, f.path).split('|')
            val ok = res[0] == "OK"
            r.status.text = if (ok) "✓ IMPORTATO / VALIDO (${res.getOrElse(2) { "" }})$name" else res.getOrElse(1) { "File non valido" }
            if (!ok) all = false
        }
        summary.text = if (all) "✓ bios7 ✓ bios9 ✓ firmware ✓ refs.json: tutto pronto, AVVIA è disponibile" else "Mancano dei file"
        summary.setTextColor(if (all) 0xFF6FE3A1.toInt() else 0xFFFFC857.toInt())
    }

    private fun pickedName(uri: Uri): String? = try {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    } catch (_: Exception) { null }

    private fun import(slot: SysFiles.Slot, uri: Uri) {
        val row = rows.first { it.slot.kind == slot.kind }
        row.status.text = "Controllo in corso…"
        val name = pickedName(uri)
        Thread {
            val input = try { contentResolver.openInputStream(uri) } catch (_: Exception) { null }
            val why = if (input == null) "Non riesco a leggere il file." else store.import(slot, name, input) { tmp ->
                if (slot.kind == SysFiles.REFS_KIND) RefsCheck.validate(tmp.readText())
                else Native.nativeCheckSysFile(slot.kind, tmp.path).split('|').let { if (it[0] == "OK") null else it.getOrElse(1) { "File non valido" } }
            }
            if (why == null) { try { contentResolver.takePersistableUriPermission(uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) { /* not every provider offers it; the private copy is what the app uses */ } }
            runOnUiThread {
                refresh()
                if (slot.kind == SysFiles.REFS_KIND) {
                    row.status.text = if (why == null) "refs.json importato · ${row.status.text}" else RefsCheck.verdict(why)
                } else if (why != null) {
                    row.status.text = why
                }
            }
        }.start()
    }
}
