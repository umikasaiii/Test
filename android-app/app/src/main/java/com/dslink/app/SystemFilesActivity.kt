package com.dslink.app

import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import java.io.File

/**
 * The user's own Nintendo DS system files (bios7.bin, bios9.bin, firmware.bin). They are picked with the system file picker (Storage Access Framework),
 * copied into THIS app's private storage (the Runtime needs real paths), validated with the same DSLink C++ code the desktop tools use, and never leave
 * the phone: they are not in the APK, not in the repository, not in any artifact, not in any log.
 */
class SystemFilesActivity : ComponentActivity() {
    private data class Row(val kind: Int, val file: String, val title: String, val status: TextView, val button: Button)
    private val rows = ArrayList<Row>()
    private lateinit var summary: TextView
    private var pickKind = -1

    private val pick = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { import(pickKind, it) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(40, 90, 40, 40); setBackgroundColor(0xFF050912.toInt()) }
        fun text(s: String, sp: Float, c: Int = Color.WHITE, bold: Boolean = false) = TextView(this).apply {
            text = s; textSize = sp; setTextColor(c); if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD); setPadding(0, 8, 0, 8)
        }
        col.addView(text("File di sistema Nintendo DS", 22f, bold = true))
        col.addView(text("Servono per far partire il Nintendo DS e il Download Play. Scegli i tuoi file: restano solo su questo telefono, non vengono mai inviati né inclusi nell'app.", 14f, 0xFFAFC4E8.toInt()))
        for ((kind, file, title) in listOf(Triple(0, "bios7.bin", "BIOS ARM7"), Triple(1, "bios9.bin", "BIOS ARM9"), Triple(2, "firmware.bin", "Firmware"))) {
            val st = text("", 13f, 0xFFAFC4E8.toInt())
            val b = Button(this).apply { text = "SCEGLI FILE"; minHeight = 150; setOnClickListener { pickKind = kind; pick.launch(arrayOf("*/*")) } }
            col.addView(text("$title ($file)", 16f, bold = true)); col.addView(st); col.addView(b, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 12 })
            rows += Row(kind, file, title, st, b)
        }
        summary = text("", 15f, 0xFF6FE3A1.toInt(), true).apply { gravity = Gravity.CENTER }
        col.addView(summary)
        setContentView(ScrollView(this).apply { setBackgroundColor(0xFF050912.toInt()); addView(col) })
        refresh()
    }

    private fun target(file: String) = File(Stack.systemDir(this), file)

    private fun refresh() {
        var all = true
        for (r in rows) {
            val f = target(r.file)
            if (!f.exists()) { r.status.text = "Non presente"; all = false; continue }
            val res = Native.nativeCheckSysFile(r.kind, f.path).split('|')
            val ok = res[0] == "OK"
            r.status.text = if (ok) "✓ Pronto (${res.getOrElse(2) { "" }})" else res.getOrElse(1) { "File non valido" }
            if (!ok) all = false
        }
        summary.text = if (all) "✓ Tutto pronto per il Download Play" else "Mancano dei file"
        summary.setTextColor(if (all) 0xFF6FE3A1.toInt() else 0xFFFFC857.toInt())
    }

    private fun import(kind: Int, uri: Uri) {
        val row = rows.first { it.kind == kind }
        row.status.text = "Controllo in corso…"
        Thread {
            val dir = Stack.systemDir(this); dir.mkdirs()
            val tmp = File(dir, row.file + ".part")
            try {
                contentResolver.openInputStream(uri)?.use { i -> tmp.outputStream().use { o -> i.copyTo(o) } }
                val res = Native.nativeCheckSysFile(kind, tmp.path).split('|')
                if (res[0] == "OK") { target(row.file).delete(); tmp.renameTo(target(row.file)) } else { tmp.delete(); runOnUiThread { row.status.text = res.getOrElse(1) { "File non valido" } }; return@Thread }
                try { contentResolver.takePersistableUriPermission(uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) { }
            } catch (e: Exception) { tmp.delete(); runOnUiThread { row.status.text = "Non riesco a leggere il file." ; return@runOnUiThread } }
            runOnUiThread { refresh() }
        }.start()
    }
}
