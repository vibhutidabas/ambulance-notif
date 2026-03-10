package com.example.ambulance

import android.animation.ValueAnimator
import android.media.AudioManager
import android.media.ToneGenerator
import androidx.core.animation.doOnEnd
import androidx.lifecycle.LifecycleCoroutineScope
import com.google.android.gms.maps.GoogleMap
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.Marker
import com.google.android.gms.maps.model.MarkerOptions
import com.google.android.libraries.navigation.NavigationApi
import com.google.android.libraries.navigation.Navigator
import com.google.android.libraries.navigation.SupportNavigationFragment
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach

class AmbulanceNavigationController(
    private val navigationFragment: SupportNavigationFragment,
    private val googleMap: GoogleMap,
    private val eventSocket: AmbulanceEventSocket,
    private val overlay: NavigationAlertOverlay,
    private val lifecycleScope: LifecycleCoroutineScope,
    private val onRerouteSuggested: ((AmbulanceAlertEvent) -> Unit)? = null
) {
    private val markers = mutableMapOf<String, Marker>()
    private val toneGenerator = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 60)
    private var navigator: Navigator? = null

    fun attach(activity: androidx.fragment.app.FragmentActivity) {
        NavigationApi.getNavigator(activity, object : NavigationApi.NavigatorListener {
            override fun onNavigatorReady(readyNavigator: Navigator) {
                navigator = readyNavigator
                navigationFragment.setNavigationUiEnabled(true)
            }

            override fun onError(errorCode: Int) {
                // Surface initialization failures in app logging or telemetry.
            }
        })

        eventSocket.markerEvents
            .onEach { updateAmbulanceMarker(it) }
            .launchIn(lifecycleScope)

        eventSocket.alertEvents
            .onEach { alert ->
                overlay.show(alert.message, alert.distanceMeters, alert.severity)
                playSafetyCue()
                if (alert.rerouteSuggestion != null) {
                    onRerouteSuggested?.invoke(alert)
                }
            }
            .launchIn(lifecycleScope)
    }

    fun registerDriverRoute(
        sessionId: String,
        driverId: String,
        pushToken: String?,
        currentLatLng: LatLng,
        routePolyline: List<LatLng>,
        heading: Float?,
        speedMps: Float?
    ) {
        eventSocket.registerRoute(
            sessionId = sessionId,
            driverId = driverId,
            appState = "foreground",
            pushToken = pushToken,
            currentLat = currentLatLng.latitude,
            currentLng = currentLatLng.longitude,
            heading = heading,
            speedMps = speedMps,
            routeId = "current-nav-route",
            polyline = routePolyline
        )
    }

    private fun updateAmbulanceMarker(event: AmbulanceMarkerEvent) {
        val target = LatLng(event.lat, event.lng)
        val existing = markers[event.ambulanceId]

        if (existing == null) {
            markers[event.ambulanceId] = createMarker(target, event)
            return
        }

        animateMarker(existing, target)
        event.heading?.let { existing.rotation = it }
        existing.snippet = event.status
    }

    private fun createMarker(target: LatLng, event: AmbulanceMarkerEvent): Marker {
        // Google currently documents AdvancedMarkerOptions as not applying to the
        // Navigation SDK on Android, so keep the active-guidance surface simple.
        return googleMap.addMarker(
            MarkerOptions()
                .position(target)
                .title("Ambulance")
                .snippet(event.status)
                .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_RED))
        )!!
    }

    private fun animateMarker(marker: Marker, target: LatLng) {
        val start = marker.position
        ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 900
            addUpdateListener { animator ->
                val fraction = animator.animatedValue as Float
                marker.position = LatLng(
                    start.latitude + (target.latitude - start.latitude) * fraction,
                    start.longitude + (target.longitude - start.longitude) * fraction
                )
            }
            doOnEnd { marker.position = target }
            start()
        }
    }

    private fun playSafetyCue() {
        toneGenerator.startTone(ToneGenerator.TONE_PROP_BEEP, 180)
    }
}
