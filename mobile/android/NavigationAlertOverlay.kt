package com.example.ambulance

import android.content.Context
import android.util.AttributeSet
import android.view.LayoutInflater
import android.widget.FrameLayout
import android.widget.TextView

class NavigationAlertOverlay @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : FrameLayout(context, attrs) {

    private val titleView: TextView
    private val subtitleView: TextView

    init {
        LayoutInflater.from(context).inflate(R.layout.view_navigation_alert_overlay, this, true)
        titleView = findViewById(R.id.alertTitle)
        subtitleView = findViewById(R.id.alertSubtitle)
        alpha = 0f
    }

    fun show(message: String, distanceMeters: Int, severity: String) {
        titleView.text = when (severity) {
            "critical" -> "Ambulance nearby"
            "warning" -> "Ambulance approaching"
            else -> "Emergency vehicle alert"
        }
        subtitleView.text = "$message • ${distanceMeters} m"

        animate()
            .alpha(1f)
            .setDuration(150)
            .start()
    }

    fun hide() {
        animate()
            .alpha(0f)
            .setDuration(150)
            .start()
    }
}

