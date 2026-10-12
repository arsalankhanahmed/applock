package com.applock.vault.learn

import org.json.JSONArray
import org.json.JSONObject

/** One micro-slide: a one-line headline plus a very short explanation (readable in 2-5 seconds). */
data class Slide(val headline: String, val detail: String) {
    fun toJson(): JSONObject = JSONObject().put("headline", headline).put("detail", detail)

    companion object {
        fun fromJson(o: JSONObject) = Slide(o.optString("headline"), o.optString("detail"))
    }
}

/**
 * A small piece of the book (e.g. "Chapter 1 › Introduction", pages 3-5).
 * Slides are generated lazily, unit by unit, in reading order.
 */
data class LessonUnit(
    val chapter: String,
    val section: String,
    val pages: String,
    var slides: MutableList<Slide>? = null,
) {
    val isGenerated: Boolean get() = slides != null

    fun toJson(): JSONObject = JSONObject()
        .put("chapter", chapter)
        .put("section", section)
        .put("pages", pages)
        .apply { slides?.let { s -> put("slides", JSONArray().apply { s.forEach { put(it.toJson()) } }) } }

    companion object {
        fun fromJson(o: JSONObject): LessonUnit {
            val arr = o.optJSONArray("slides")
            val slides = arr?.let { a -> MutableList(a.length()) { Slide.fromJson(a.getJSONObject(it)) } }
            return LessonUnit(o.optString("chapter"), o.optString("section"), o.optString("pages"), slides)
        }
    }
}

data class Book(
    val id: String,
    var title: String,
    var language: String,
    /** Local copy of the PDF inside app storage (re-uploaded when the Gemini file expires). */
    val pdfPath: String,
    var geminiFileUri: String? = null,
    var geminiFileUploadedAt: Long = 0,
    val units: MutableList<LessonUnit> = mutableListOf(),
    /** Reading cursor: which unit and which slide inside it is shown next. */
    var unitIndex: Int = 0,
    var slideIndex: Int = 0,
    var slidesSeen: Int = 0,
) {
    val generatedSlideCount: Int get() = units.sumOf { it.slides?.size ?: 0 }
    val isFinished: Boolean get() = unitIndex >= units.size

    /** Slides that are generated but not yet shown. */
    fun bufferedSlides(): Int {
        var count = 0
        for (i in unitIndex until units.size) {
            val s = units[i].slides ?: break
            count += if (i == unitIndex) (s.size - slideIndex).coerceAtLeast(0) else s.size
        }
        return count
    }

    fun nextUngeneratedUnit(): Int = units.indexOfFirst { !it.isGenerated }

    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("title", title)
        .put("language", language)
        .put("pdfPath", pdfPath)
        .put("geminiFileUri", geminiFileUri ?: JSONObject.NULL)
        .put("geminiFileUploadedAt", geminiFileUploadedAt)
        .put("units", JSONArray().apply { units.forEach { put(it.toJson()) } })
        .put("unitIndex", unitIndex)
        .put("slideIndex", slideIndex)
        .put("slidesSeen", slidesSeen)

    companion object {
        fun fromJson(o: JSONObject): Book {
            val arr = o.optJSONArray("units") ?: JSONArray()
            return Book(
                id = o.getString("id"),
                title = o.optString("title"),
                language = o.optString("language"),
                pdfPath = o.getString("pdfPath"),
                geminiFileUri = if (o.isNull("geminiFileUri")) null else o.optString("geminiFileUri"),
                geminiFileUploadedAt = o.optLong("geminiFileUploadedAt"),
                units = MutableList(arr.length()) { LessonUnit.fromJson(arr.getJSONObject(it)) },
                unitIndex = o.optInt("unitIndex"),
                slideIndex = o.optInt("slideIndex"),
                slidesSeen = o.optInt("slidesSeen"),
            )
        }
    }
}

/** What the unlock pop-up shows. */
data class SlideCard(
    val bookTitle: String,
    val chapter: String,
    val section: String,
    val slide: Slide,
    val positionLabel: String,
)
