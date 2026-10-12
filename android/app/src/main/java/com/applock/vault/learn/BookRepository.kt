package com.applock.vault.learn

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Stores imported books, turns them into a step-by-step slide queue with Gemini,
 * and hands out the next slide each time the phone is unlocked.
 *
 * Flow: import PDF -> Gemini builds the book structure (chapters/sections, in reading order)
 * -> slides are generated a few sections at a time, always staying ahead of the reader.
 */
object BookRepository {

    private const val TAG = "BookRepository"

    /** Sections turned into slides per Gemini request (the whole PDF is read on each request). */
    private const val UNITS_PER_BATCH = 4

    /** Generate more slides once fewer than this many are left unread. */
    private const val LOW_BUFFER = 10

    /** Gemini deletes uploaded files after 48 hours; re-upload a little before that. */
    private const val FILE_TTL_MS = 46L * 60 * 60 * 1000

    private val worker = Executors.newSingleThreadExecutor()
    private val generating = AtomicBoolean(false)
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()

    fun interface Progress { fun onProgress(message: String) }

    // ---------- Storage ----------

    private fun booksDir(ctx: Context) = File(ctx.filesDir, "books").apply { mkdirs() }

    fun listBooks(ctx: Context): List<Book> = synchronized(lock) {
        booksDir(ctx).listFiles()?.mapNotNull { dir ->
            runCatching { Book.fromJson(JSONObject(File(dir, "book.json").readText())) }.getOrNull()
        }?.sortedBy { it.title } ?: emptyList()
    }

    fun load(ctx: Context, id: String): Book? = synchronized(lock) {
        val f = File(File(booksDir(ctx), id), "book.json")
        if (!f.exists()) null else runCatching { Book.fromJson(JSONObject(f.readText())) }.getOrNull()
    }

    fun save(ctx: Context, book: Book) = synchronized(lock) {
        val dir = File(booksDir(ctx), book.id).apply { mkdirs() }
        val tmp = File(dir, "book.json.tmp")
        tmp.writeText(book.toJson().toString())
        tmp.renameTo(File(dir, "book.json"))
    }

    fun delete(ctx: Context, id: String) = synchronized(lock) {
        File(booksDir(ctx), id).deleteRecursively()
        val settings = LearnSettings(ctx)
        if (settings.activeBookId == id) settings.activeBookId = null
    }

    fun restart(ctx: Context, id: String) = synchronized(lock) {
        load(ctx, id)?.let {
            it.unitIndex = 0
            it.slideIndex = 0
            save(ctx, it)
        }
    }

    // ---------- Reading cursor ----------

    /**
     * Returns the next slide of the active book and moves the cursor forward.
     * Also tops up the slide queue in the background when it runs low.
     */
    fun nextSlide(ctx: Context): SlideCard? {
        val app = ctx.applicationContext
        val settings = LearnSettings(app)
        val id = settings.activeBookId ?: return null
        val card = synchronized(lock) {
            val book = load(app, id) ?: return null
            // Skip sections that produced no slides.
            while (!book.isFinished && book.units[book.unitIndex].slides?.let { book.slideIndex >= it.size } == true) {
                book.unitIndex++
                book.slideIndex = 0
            }
            if (book.isFinished) return null
            val unit = book.units[book.unitIndex]
            val slides = unit.slides
            if (slides == null) {
                null // Not generated yet; the top-up below will fetch it.
            } else {
                val slide = slides[book.slideIndex]
                val label = "${book.unitIndex + 1}/${book.units.size} · ${book.slideIndex + 1}/${slides.size}"
                book.slideIndex++
                book.slidesSeen++
                save(app, book)
                SlideCard(book.title, unit.chapter, unit.section, slide, label)
            }
        }
        topUpIfNeeded(app)
        return card
    }

    /** Peek without moving the cursor (used by the in-app preview). */
    fun peekSlide(ctx: Context): SlideCard? {
        val id = LearnSettings(ctx).activeBookId ?: return null
        val book = load(ctx, id) ?: return null
        var u = book.unitIndex
        var s = book.slideIndex
        while (u < book.units.size) {
            val slides = book.units[u].slides ?: return null
            if (s < slides.size) {
                val unit = book.units[u]
                return SlideCard(book.title, unit.chapter, unit.section, slides[s],
                    "${u + 1}/${book.units.size} · ${s + 1}/${slides.size}")
            }
            u++
            s = 0
        }
        return null
    }

    fun topUpIfNeeded(ctx: Context) {
        val id = LearnSettings(ctx).activeBookId ?: return
        val book = load(ctx, id) ?: return
        if (book.nextUngeneratedUnit() >= 0 && book.bufferedSlides() < LOW_BUFFER) {
            generateMore(ctx, id, null)
        }
    }

    // ---------- Import & generation ----------

    /** Copies the PDF into app storage, builds its structure and the first slides. */
    fun importPdf(ctx: Context, uri: Uri, progress: Progress, done: (Book?, String?) -> kotlin.Unit) {
        val app = ctx.applicationContext
        worker.execute {
            val id = UUID.randomUUID().toString()
            try {
                val settings = LearnSettings(app)
                if (settings.apiKey.isBlank()) throw IOException("Please save your Gemini API key first.")
                val client = GeminiClient(settings.apiKey, settings.model)

                post(progress, "Copying PDF…")
                val dir = File(booksDir(app), id).apply { mkdirs() }
                val pdf = File(dir, "book.pdf")
                app.contentResolver.openInputStream(uri)?.use { input ->
                    pdf.outputStream().use { input.copyTo(it) }
                } ?: throw IOException("Could not open the selected file")
                val fileName = displayName(app, uri) ?: "Book"

                post(progress, "Uploading book to Gemini (${pdf.length() / 1024} KB)…")
                val fileUri = client.uploadPdf(pdf, fileName)

                post(progress, "Reading the book and building its structure…")
                val outline = client.askAboutPdf(fileUri, outlinePrompt())
                val units = outline.optJSONArray("units")
                    ?: throw IOException("Gemini returned no structure for this book")
                val book = Book(
                    id = id,
                    title = outline.optString("title").ifBlank { fileName.removeSuffix(".pdf") },
                    language = outline.optString("language"),
                    pdfPath = pdf.absolutePath,
                    geminiFileUri = fileUri,
                    geminiFileUploadedAt = System.currentTimeMillis(),
                )
                for (i in 0 until units.length()) {
                    val u = units.getJSONObject(i)
                    book.units.add(LessonUnit(u.optString("chapter"), u.optString("section"), u.optString("pages")))
                }
                if (book.units.isEmpty()) throw IOException("Gemini found no readable sections in this PDF")
                save(app, book)
                settings.activeBookId = id

                post(progress, "Structure ready: ${book.units.size} sections. Creating first slides…")
                generateBatch(app, book, client)
                main.post { done(load(app, id), null) }
            } catch (e: Exception) {
                Log.e(TAG, "Import failed", e)
                if (load(app, id)?.units.isNullOrEmpty()) delete(app, id)
                main.post { done(null, e.message ?: e.toString()) }
            }
        }
    }

    /** Generates slides for the next few sections of a book (no-op if a job is already running). */
    fun generateMore(ctx: Context, id: String, done: ((String?) -> kotlin.Unit)?) {
        val app = ctx.applicationContext
        if (!generating.compareAndSet(false, true)) {
            done?.let { cb -> main.post { cb("Already generating, please wait…") } }
            return
        }
        worker.execute {
            var error: String? = null
            try {
                val settings = LearnSettings(app)
                if (settings.apiKey.isBlank()) throw IOException("Gemini API key missing")
                val book = load(app, id) ?: throw IOException("Book not found")
                generateBatch(app, book, GeminiClient(settings.apiKey, settings.model))
            } catch (e: Exception) {
                Log.w(TAG, "Slide generation failed", e)
                error = e.message ?: e.toString()
            } finally {
                generating.set(false)
            }
            done?.let { cb -> main.post { cb(error) } }
        }
    }

    private fun generateBatch(ctx: Context, book: Book, client: GeminiClient) {
        val first = book.nextUngeneratedUnit()
        if (first < 0) return
        val indices = (first until minOf(first + UNITS_PER_BATCH, book.units.size)).toList()
        val settings = LearnSettings(ctx)
        val prompt = slidesPrompt(book, indices, settings.explainLanguage)

        val answer = try {
            client.askAboutPdf(ensureUploaded(ctx, book, client, force = false), prompt)
        } catch (e: GeminiClient.ApiException) {
            // Uploaded file expired or was deleted: upload again and retry once.
            if (e.code != 403 && e.code != 404 && e.code != 400) throw e
            client.askAboutPdf(ensureUploaded(ctx, book, client, force = true), prompt)
        }

        val results = answer.optJSONArray("units") ?: throw IOException("Gemini returned no slides")
        synchronized(lock) {
            // Reload so we do not overwrite reading progress made while Gemini was working.
            val fresh = load(ctx, book.id) ?: return
            fresh.geminiFileUri = book.geminiFileUri
            fresh.geminiFileUploadedAt = book.geminiFileUploadedAt
            for (r in 0 until results.length()) {
                val o = results.getJSONObject(r)
                val idx = o.optInt("index", -1)
                if (idx !in indices) continue
                val arr = o.optJSONArray("slides") ?: continue
                fresh.units[idx].slides = MutableList(arr.length()) { Slide.fromJson(arr.getJSONObject(it)) }
                    .filter { it.headline.isNotBlank() }.toMutableList()
            }
            // Sections Gemini skipped are marked empty so the queue keeps moving.
            indices.forEach { if (fresh.units[it].slides == null) fresh.units[it].slides = mutableListOf() }
            save(ctx, fresh)
        }
    }

    private fun ensureUploaded(ctx: Context, book: Book, client: GeminiClient, force: Boolean): String {
        val uri = book.geminiFileUri
        val fresh = System.currentTimeMillis() - book.geminiFileUploadedAt < FILE_TTL_MS
        if (!force && uri != null && fresh) return uri
        val newUri = client.uploadPdf(File(book.pdfPath), book.title)
        book.geminiFileUri = newUri
        book.geminiFileUploadedAt = System.currentTimeMillis()
        synchronized(lock) {
            load(ctx, book.id)?.let {
                it.geminiFileUri = newUri
                it.geminiFileUploadedAt = book.geminiFileUploadedAt
                save(ctx, it)
            }
        }
        return newUri
    }

    // ---------- Prompts ----------

    private fun outlinePrompt() = """
        You are preparing this book for micro-learning: the reader will see ONE tiny slide each time
        they unlock their phone (2-5 seconds of reading), moving step by step through the book.

        First build the book's structure in exact reading order (introduction first, then each chapter).
        Split it into small learning sections, each covering roughly 1-5 pages of real content.
        Skip cover, copyright, table of contents, index, bibliography and blank pages.
        Use at most 400 sections; for very long books make sections larger rather than skipping content.

        Write chapter and section names in the book's own language.
        Answer ONLY with JSON in this exact shape:
        {"title": "book title", "language": "language of the book",
         "units": [{"chapter": "chapter name", "section": "section name", "pages": "e.g. 3-5"}]}
    """.trimIndent()

    private fun slidesPrompt(book: Book, indices: List<Int>, explainLanguage: String): String {
        val language = explainLanguage.ifBlank { "the same language the book is written in (${book.language})" }
        val list = indices.joinToString("\n") { i ->
            val u = book.units[i]
            "- index $i: chapter \"${u.chapter}\", section \"${u.section}\", pages ${u.pages}"
        }
        val previous = book.units.getOrNull(indices.first() - 1)?.let {
            "The reader has just finished: \"${it.chapter} › ${it.section}\"."
        } ?: "This is the very beginning of the book."
        return """
            You are a teacher turning this book into micro-slides shown on a phone lock screen.
            $previous
            Create the slides for these sections of the book:
            $list

            Rules for every slide:
            - It must be readable in 2-5 seconds.
            - "headline": ONE line, the key idea, max 12 words.
            - "detail": a very brief explanation, max 25 words, that makes the idea stick.
            - Follow the book's own order, one idea per slide, building step by step.
            - Use the book's actual content (definitions, facts, arguments, examples), not generic advice.
            - 3 to 8 slides per section depending on how much it contains.
            - Write all slides in $language.

            Answer ONLY with JSON in this exact shape:
            {"units": [{"index": <section index>, "slides": [{"headline": "...", "detail": "..."}]}]}
        """.trimIndent()
    }

    // ---------- Helpers ----------

    private fun post(progress: Progress, msg: String) = main.post { progress.onProgress(msg) }

    private fun displayName(ctx: Context, uri: Uri): String? =
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
}
