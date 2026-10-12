package com.applock.vault.learn

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Minimal Gemini REST client (no extra dependencies).
 * The PDF is uploaded once through the Files API so Gemini can read any language,
 * including scanned books, and every later request only references the uploaded file.
 */
class GeminiClient(private val apiKey: String, private val model: String) {

    class ApiException(val code: Int, message: String) : IOException(message)

    /** Uploads a PDF and waits until Gemini has processed it. Returns the file URI. */
    fun uploadPdf(pdf: File, displayName: String): String {
        val start = open("$BASE/upload/v1beta/files", "POST").apply {
            setRequestProperty("X-Goog-Upload-Protocol", "resumable")
            setRequestProperty("X-Goog-Upload-Command", "start")
            setRequestProperty("X-Goog-Upload-Header-Content-Length", pdf.length().toString())
            setRequestProperty("X-Goog-Upload-Header-Content-Type", "application/pdf")
            setRequestProperty("Content-Type", "application/json")
        }
        writeBody(start, JSONObject().put("file", JSONObject().put("display_name", displayName)).toString())
        readResponse(start)
        val uploadUrl = start.getHeaderField("X-Goog-Upload-URL")
            ?: throw IOException("Gemini did not return an upload URL")

        val upload = open(uploadUrl, "POST").apply {
            setRequestProperty("X-Goog-Upload-Offset", "0")
            setRequestProperty("X-Goog-Upload-Command", "upload, finalize")
            setFixedLengthStreamingMode(pdf.length())
            doOutput = true
        }
        upload.outputStream.use { out -> pdf.inputStream().use { it.copyTo(out) } }
        var file = JSONObject(readResponse(upload)).getJSONObject("file")

        // Large PDFs are processed asynchronously; poll until ACTIVE.
        val name = file.getString("name")
        repeat(60) {
            when (file.optString("state")) {
                "ACTIVE" -> return file.getString("uri")
                "FAILED" -> throw IOException("Gemini could not process this PDF")
            }
            Thread.sleep(3000)
            file = JSONObject(readResponse(open("$BASE/v1beta/$name", "GET")))
        }
        throw IOException("Timed out waiting for Gemini to process the PDF")
    }

    /** Sends the uploaded PDF plus a prompt and returns the parsed JSON answer. */
    fun askAboutPdf(fileUri: String, prompt: String): JSONObject {
        val body = JSONObject()
            .put("contents", JSONArray().put(JSONObject()
                .put("role", "user")
                .put("parts", JSONArray()
                    .put(JSONObject().put("file_data", JSONObject()
                        .put("mime_type", "application/pdf")
                        .put("file_uri", fileUri)))
                    .put(JSONObject().put("text", prompt)))))
            .put("generationConfig", JSONObject().put("responseMimeType", "application/json"))

        val conn = open("$BASE/v1beta/models/$model:generateContent", "POST").apply {
            setRequestProperty("Content-Type", "application/json")
        }
        writeBody(conn, body.toString())
        val response = JSONObject(readResponse(conn))
        val parts = response.optJSONArray("candidates")?.optJSONObject(0)
            ?.optJSONObject("content")?.optJSONArray("parts")
            ?: throw IOException("Empty answer from Gemini: ${response.toString().take(300)}")

        val text = StringBuilder()
        for (i in 0 until parts.length()) {
            val p = parts.getJSONObject(i)
            if (!p.optBoolean("thought")) text.append(p.optString("text"))
        }
        return parseJson(text.toString())
    }

    private fun open(url: String, method: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 30_000
            readTimeout = 300_000
            setRequestProperty("x-goog-api-key", apiKey)
        }

    private fun writeBody(conn: HttpURLConnection, body: String) {
        conn.doOutput = true
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
    }

    private fun readResponse(conn: HttpURLConnection): String {
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        if (code !in 200..299) {
            val msg = runCatching { JSONObject(text).getJSONObject("error").getString("message") }
                .getOrDefault(text.take(300))
            throw ApiException(code, "Gemini error $code: $msg")
        }
        return text
    }

    companion object {
        private const val BASE = "https://generativelanguage.googleapis.com"

        /** Tolerates answers wrapped in ```json fences or with text around the object. */
        fun parseJson(raw: String): JSONObject {
            val start = raw.indexOf('{')
            val end = raw.lastIndexOf('}')
            if (start < 0 || end <= start) throw IOException("Gemini did not return JSON")
            return JSONObject(raw.substring(start, end + 1))
        }
    }
}
