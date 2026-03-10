package com.example.ambulance

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

data class RerouteOption(
    val id: String,
    val distanceMeters: Int,
    val durationSeconds: Int,
    val recommended: Boolean,
    val intersectsAvoidZone: Boolean
)

class RerouteApiClient(
    private val backendHttpBaseUrl: String,
    private val client: OkHttpClient = OkHttpClient()
) {
    fun requestAlternatives(
        origin: com.google.android.gms.maps.model.LatLng,
        destination: com.google.android.gms.maps.model.LatLng,
        suggestion: RerouteSuggestion,
        onSuccess: (List<RerouteOption>) -> Unit,
        onError: (String) -> Unit
    ) {
        val payload = JSONObject()
            .put("origin", JSONObject().put("lat", origin.latitude).put("lng", origin.longitude))
            .put("destination", JSONObject().put("lat", destination.latitude).put("lng", destination.longitude))
            .put("avoidPoint", JSONObject().put("lat", suggestion.avoidLat).put("lng", suggestion.avoidLng))
            .put("avoidRadiusMeters", suggestion.avoidRadiusMeters)
            .put("alternativeCount", 3)

        val request = Request.Builder()
            .url("$backendHttpBaseUrl/reroute-options")
            .post(payload.toString().toRequestBody("application/json".toMediaType()))
            .build()

        client.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                onError(e.message ?: "Unknown network error")
            }

            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                response.use {
                    if (!response.isSuccessful) {
                        onError("Reroute API failed with ${response.code}")
                        return
                    }

                    val body = response.body?.string().orEmpty()
                    val json = JSONObject(body)
                    val routes = json.optJSONArray("routes") ?: JSONArray()
                    val result = mutableListOf<RerouteOption>()
                    for (index in 0 until routes.length()) {
                        val route = routes.getJSONObject(index)
                        result += RerouteOption(
                            id = route.getString("id"),
                            distanceMeters = route.getInt("distanceMeters"),
                            durationSeconds = route.getInt("durationSeconds"),
                            recommended = route.optBoolean("recommended", false),
                            intersectsAvoidZone = route.optBoolean("intersectsAvoidZone", false)
                        )
                    }
                    onSuccess(result)
                }
            }
        })
    }
}

