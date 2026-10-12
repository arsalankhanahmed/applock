package com.applock.vault.learn

import android.accessibilityservice.AccessibilityService
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.widget.ProgressBar
import android.widget.TextView
import com.applock.vault.R

/**
 * Shows one slide as a small card on top of whatever is on screen, then fades it away.
 * Uses an accessibility overlay, so no extra "display over other apps" permission is needed.
 */
class LearnOverlay(private val service: AccessibilityService) {

    private val wm = service.getSystemService(WindowManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private var view: View? = null
    private val tick = 50L

    fun show(card: SlideCard, seconds: Int) {
        hide()
        val v = LayoutInflater.from(service).inflate(R.layout.overlay_learn_slide, null)
        bind(v, card)

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP
            y = (service.resources.displayMetrics.density * 48).toInt()
        }

        // Tap the card for the next slide, tap X to close.
        v.findViewById<View>(R.id.learnClose).setOnClickListener { hide() }
        v.setOnClickListener {
            val next = BookRepository.nextSlide(service)
            if (next != null) show(next, seconds) else hide()
        }

        try {
            wm.addView(v, params)
        } catch (e: Exception) {
            return
        }
        view = v
        v.alpha = 0f
        v.animate().alpha(1f).setDuration(180).start()
        startCountdown(v, seconds * 1000L)
    }

    private fun bind(v: View, card: SlideCard) {
        v.findViewById<TextView>(R.id.learnPath).text =
            listOf(card.chapter, card.section).filter { it.isNotBlank() }.distinct().joinToString(" › ")
        v.findViewById<TextView>(R.id.learnHeadline).text = card.slide.headline
        v.findViewById<TextView>(R.id.learnDetail).apply {
            text = card.slide.detail
            visibility = if (card.slide.detail.isBlank()) View.GONE else View.VISIBLE
        }
        v.findViewById<TextView>(R.id.learnPosition).text = "${card.bookTitle} · ${card.positionLabel} · tap → next"
    }

    private fun startCountdown(v: View, totalMs: Long) {
        val bar = v.findViewById<ProgressBar>(R.id.learnTimer)
        bar.max = totalMs.toInt()
        val startedAt = System.currentTimeMillis()
        val step = object : Runnable {
            override fun run() {
                if (view !== v) return
                val left = totalMs - (System.currentTimeMillis() - startedAt)
                if (left <= 0) {
                    hide()
                } else {
                    bar.progress = left.toInt()
                    handler.postDelayed(this, tick)
                }
            }
        }
        handler.post(step)
    }

    fun hide() {
        handler.removeCallbacksAndMessages(null)
        val v = view ?: return
        view = null
        try {
            wm.removeView(v)
        } catch (_: Exception) {
        }
    }
}
