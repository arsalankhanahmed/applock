package com.applock.vault.learn

import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ListView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.applock.vault.R

/** Settings + book library for the "learn a book on every unlock" feature. */
class LearnActivity : AppCompatActivity() {

    private lateinit var settings: LearnSettings
    private lateinit var status: TextView
    private var books: List<Book> = emptyList()

    private val pickPdf = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@registerForActivityResult
        saveSettings()
        setBusy(true, "Starting import…")
        BookRepository.importPdf(this, uri, { setBusy(true, it) }) { book, error ->
            if (book != null) {
                setBusy(false, "✅ \"${book.title}\" ready: ${book.units.size} sections, " +
                    "${book.generatedSlideCount} slides so far. Lock and unlock your phone to start!")
            } else {
                setBusy(false, "❌ Import failed: $error")
            }
            refreshBooks()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_learn)
        settings = LearnSettings(this)
        status = findViewById(R.id.learnStatus)

        findViewById<EditText>(R.id.inputApiKey).setText(settings.apiKey)
        findViewById<EditText>(R.id.inputModel).setText(settings.model)
        findViewById<EditText>(R.id.inputLanguage).setText(settings.explainLanguage)
        findViewById<EditText>(R.id.inputSeconds).setText(settings.displaySeconds.toString())
        findViewById<EditText>(R.id.inputInterval).setText(settings.usageIntervalMinutes.toString())
        findViewById<Switch>(R.id.switchEnabled).isChecked = settings.enabled
        findViewById<Switch>(R.id.switchUnlock).isChecked = settings.showOnUnlock

        findViewById<Button>(R.id.btnSaveLearn).setOnClickListener {
            saveSettings()
            Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
        }
        findViewById<Button>(R.id.btnImportPdf).setOnClickListener {
            if (findViewById<EditText>(R.id.inputApiKey).text.isBlank()) {
                Toast.makeText(this, "Enter your Gemini API key first", Toast.LENGTH_LONG).show()
            } else {
                pickPdf.launch(arrayOf("application/pdf"))
            }
        }
        findViewById<Button>(R.id.btnPreview).setOnClickListener { preview() }
        findViewById<Button>(R.id.btnAccessibility).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            Toast.makeText(this, "Enable 'AppLock & Vault' service", Toast.LENGTH_LONG).show()
        }

        val list = findViewById<ListView>(R.id.booksList)
        list.setOnItemClickListener { _, _, pos, _ -> bookActions(books[pos]) }
    }

    override fun onResume() {
        super.onResume()
        refreshBooks()
    }

    private fun saveSettings() {
        settings.apiKey = findViewById<EditText>(R.id.inputApiKey).text.toString()
        settings.model = findViewById<EditText>(R.id.inputModel).text.toString()
        settings.explainLanguage = findViewById<EditText>(R.id.inputLanguage).text.toString()
        settings.displaySeconds = findViewById<EditText>(R.id.inputSeconds).text.toString().toIntOrNull() ?: 5
        settings.usageIntervalMinutes = findViewById<EditText>(R.id.inputInterval).text.toString().toIntOrNull() ?: 0
        settings.enabled = findViewById<Switch>(R.id.switchEnabled).isChecked
        settings.showOnUnlock = findViewById<Switch>(R.id.switchUnlock).isChecked
    }

    private fun refreshBooks() {
        books = BookRepository.listBooks(this)
        val active = settings.activeBookId
        val rows = books.map { b ->
            val mark = if (b.id == active) "▶ " else "   "
            val progress = if (b.isFinished) "finished 🎉" else "section ${b.unitIndex + 1}/${b.units.size}"
            "$mark${b.title}\n     ${b.language} · $progress · ${b.slidesSeen} slides read"
        }
        findViewById<ListView>(R.id.booksList).adapter =
            ArrayAdapter(this, R.layout.item_learn_book, rows)
        findViewById<TextView>(R.id.booksEmpty).visibility = if (books.isEmpty()) View.VISIBLE else View.GONE
    }

    private fun bookActions(book: Book) {
        val options = arrayOf("Learn this book on unlock", "Generate more slides now", "Restart from beginning", "Delete")
        AlertDialog.Builder(this)
            .setTitle(book.title)
            .setItems(options) { _, which ->
                when (which) {
                    0 -> {
                        settings.activeBookId = book.id
                        BookRepository.topUpIfNeeded(this)
                        refreshBooks()
                    }
                    1 -> {
                        saveSettings()
                        setBusy(true, "Generating more slides…")
                        BookRepository.generateMore(this, book.id) { error ->
                            setBusy(false, error?.let { "❌ $it" } ?: "✅ More slides ready")
                            refreshBooks()
                        }
                    }
                    2 -> {
                        BookRepository.restart(this, book.id)
                        refreshBooks()
                    }
                    3 -> AlertDialog.Builder(this)
                        .setMessage("Delete \"${book.title}\"?")
                        .setPositiveButton("Delete") { _, _ ->
                            BookRepository.delete(this, book.id)
                            refreshBooks()
                        }
                        .setNegativeButton("Cancel", null)
                        .show()
                }
            }
            .show()
    }

    private fun preview() {
        val card = BookRepository.peekSlide(this)
        if (card == null) {
            Toast.makeText(this, "No slide ready. Import a book or generate more slides.", Toast.LENGTH_LONG).show()
            return
        }
        AlertDialog.Builder(this)
            .setTitle(card.slide.headline)
            .setMessage("${card.slide.detail}\n\n${card.chapter} › ${card.section}\n${card.positionLabel}")
            .setPositiveButton("OK", null)
            .show()
    }

    private fun setBusy(busy: Boolean, message: String) {
        status.text = message
        findViewById<View>(R.id.learnProgress).visibility = if (busy) View.VISIBLE else View.GONE
        findViewById<Button>(R.id.btnImportPdf).isEnabled = !busy
    }
}
