package com.example.ambulance

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject

data class AmbulanceMarkerEvent(
    val ambulanceId: String,
    val status: String,
    val lat: Double,
    val lng: Double,
    val heading: Float?,
    val distanceMeters: Int?
)

data class AmbulanceAlertEvent(
    val ambulanceId: String,
    val severity: String,
    val matchType: String,
    val message: String,
    val distanceMeters: Int,
    val timeToImpactSeconds: Int,
    val predictedIntersection: PredictedIntersection?,
    val rerouteSuggestion: RerouteSuggestion?
)

data class PredictedIntersection(
    val lat: Double,
    val lng: Double,
    val ambulanceTimeToIntersectionSeconds: Int
)

data class RerouteSuggestion(
    val reason: String,
    val avoidLat: Double,
    val avoidLng: Double,
    val avoidRadiusMeters: Int,
    val recommendedWithinSeconds: Int
)

class AmbulanceEventSocket(
    private val backendUrl: String,
    private val client: OkHttpClient = OkHttpClient()
) {
    private var webSocket: WebSocket? = null
    private val _markerEvents = MutableSharedFlow<AmbulanceMarkerEvent>(extraBufferCapacity = 16)
    private val _alertEvents = MutableSharedFlow<AmbulanceAlertEvent>(extraBufferCapacity = 16)

    val markerEvents = _markerEvents.asSharedFlow()
    val alertEvents = _alertEvents.asSharedFlow()

    fun connect() {
        val request = Request.Builder()
            .url("$backendUrl/ws/drivers")
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val payload = JSONObject(text)
                when (payload.getString("type")) {
                    "ambulance.marker" -> _markerEvents.tryEmit(
                        AmbulanceMarkerEvent(
                            ambulanceId = payload.getString("ambulanceId"),
                            status = payload.getString("status"),
                            lat = payload.getJSONObject("position").getDouble("lat"),
                            lng = payload.getJSONObject("position").getDouble("lng"),
                            heading = payload.getJSONObject("position")
                                .optDouble("heading")
                                .takeIf { !it.isNaN() }
                                ?.toFloat(),
                            distanceMeters = payload.optInt("distanceMeters")
                                .takeIf { payload.has("distanceMeters") }
                        )
                    )

                    "ambulance.alert" -> _alertEvents.tryEmit(
                        AmbulanceAlertEvent(
                            ambulanceId = payload.getString("ambulanceId"),
                            severity = payload.getString("severity"),
                            matchType = payload.getString("matchType"),
                            message = payload.getString("message"),
                            distanceMeters = payload.getInt("distanceMeters"),
                            timeToImpactSeconds = payload.getInt("timeToImpactSeconds"),
                            predictedIntersection = payload.optJSONObject("predictedIntersection")
                                ?.let { intersection ->
                                    PredictedIntersection(
                                        lat = intersection.getJSONObject("point").getDouble("lat"),
                                        lng = intersection.getJSONObject("point").getDouble("lng"),
                                        ambulanceTimeToIntersectionSeconds = intersection
                                            .getInt("ambulanceTimeToIntersectionSeconds")
                                    )
                                },
                            rerouteSuggestion = payload.optJSONObject("rerouteSuggestion")
                                ?.let { suggestion ->
                                    RerouteSuggestion(
                                        reason = suggestion.getString("reason"),
                                        avoidLat = suggestion.getJSONObject("avoidPoint").getDouble("lat"),
                                        avoidLng = suggestion.getJSONObject("avoidPoint").getDouble("lng"),
                                        avoidRadiusMeters = suggestion.getInt("avoidRadiusMeters"),
                                        recommendedWithinSeconds = suggestion
                                            .getInt("recommendedWithinSeconds")
                                    )
                                }
                        )
                    )
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // Reconnect policy belongs in production infrastructure code.
            }
        })
    }

    fun registerRoute(
        sessionId: String,
        driverId: String,
        appState: String,
        pushToken: String?,
        currentLat: Double,
        currentLng: Double,
        heading: Float?,
        speedMps: Float?,
        routeId: String,
        polyline: List<com.google.android.gms.maps.model.LatLng>
    ) {
        val routePoints = JSONArray().apply {
            polyline.forEach { point ->
                put(JSONObject().put("lat", point.latitude).put("lng", point.longitude))
            }
        }

        val message = JSONObject()
            .put("type", "driver.register_route")
            .put("sessionId", sessionId)
            .put("driverId", driverId)
            .put("platform", "android")
            .put("appState", appState)
            .put("pushToken", pushToken)
            .put(
                "currentPosition",
                JSONObject()
                    .put("lat", currentLat)
                    .put("lng", currentLng)
                    .put("heading", heading)
                    .put("speedMps", speedMps)
                    .put("timestamp", System.currentTimeMillis())
            )
            .put(
                "route",
                JSONObject()
                    .put("routeId", routeId)
                    .put("polyline", routePoints)
            )

        webSocket?.send(message.toString())
    }

    fun sendProgress(
        sessionId: String,
        appState: String,
        currentLat: Double,
        currentLng: Double,
        heading: Float?,
        speedMps: Float?
    ) {
        val message = JSONObject()
            .put("type", "driver.progress")
            .put("sessionId", sessionId)
            .put("appState", appState)
            .put(
                "currentPosition",
                JSONObject()
                    .put("lat", currentLat)
                    .put("lng", currentLng)
                    .put("heading", heading)
                    .put("speedMps", speedMps)
                    .put("timestamp", System.currentTimeMillis())
            )

        webSocket?.send(message.toString())
    }
}
