# Architecture

## Diagram Description

```text
Ambulance Device
  -> WS or MQTT ingest
  -> Ingestion Gateway
  -> Ambulance Registry
  -> Redis TTL state
  -> Spatial Matcher

Driver Mobile App
  -> Navigation SDK route + progress upload
  -> Driver Session Registry
  -> Route Spatial Index
  -> Spatial Matcher

Spatial Matcher
  -> WebSocket event hub
  -> foreground in-app marker updates
  -> foreground alert banner + short audio cue
  -> background push adapter (FCM/APNs via FCM)
  -> reroute API adapter (Google Routes API)

Google Maps Platform
  -> Navigation SDK for Android/iOS on device
  -> Maps SDK rendering
  -> optional Roads API snapping
  -> optional Routes API / legacy Directions or Distance Matrix during migration
```

## Core Components

### 1. Ambulance Client

- Publishes GPS updates at 1 to 2 Hz over `WS /ws/ambulances`
- Can optionally attach `pathHint` points if the ambulance dispatch app has the planned road geometry
- Sends heading and speed whenever available to improve projected-path accuracy

### 2. Driver Client

- Uses Navigation SDK for Android or iOS for active route guidance
- Uploads the current route polyline, current location, heading, and app state
- Keeps a WebSocket open in foreground for live alerts and marker updates
- Falls back to push notifications when backgrounded

### 3. Ingestion Gateway

- Accepts high-frequency ambulance updates over WebSocket
- Normalizes timestamps, speed, and heading
- Stores the latest ambulance state in Redis with a short TTL such as 15 seconds

### 4. Driver Session Registry

- Stores the active route for each driver session
- Precomputes cumulative route distances and route-cell memberships
- Maintains a route spatial index so an ambulance update only evaluates nearby sessions

### 5. Spatial Matcher

- Uses corridor filtering first, then route-progress logic
- Evaluates two high-value cases:
  - Ambulance approaching from behind on the same shared corridor
  - Ambulance trajectory segments intersecting route segments ahead of the driver
- Deduplicates repeated alerts per `(ambulanceId, sessionId)` pair

### 6. Notification Fanout

- Foreground: WebSocket marker update plus minimal banner/cue
- Background: FCM data or notification message keyed to the same alert payload

## Data Flow

1. The driver app starts navigation with the Google Navigation SDK and extracts a simplified route polyline.
2. The driver app opens `WS /ws/drivers` and sends `driver.register_route`.
3. The backend stores the route, builds route-cell keys, and indexes the session.
4. The ambulance device opens `WS /ws/ambulances` and streams `ambulance.location` messages at 1 to 2 Hz.
5. Each ambulance update is written to Redis with TTL and evaluated against only route sessions whose buffered route cells overlap the ambulance trajectory cells.
6. For each candidate session, the matcher computes:
   - distance from ambulance to driver route polyline
   - route progress for the driver and ambulance
   - heading alignment with the shared segment
   - explicit trajectory/route segment intersection points and ETA
7. If the match score exceeds threshold, the backend emits:
   - `ambulance.marker` for dynamic map updates
   - `ambulance.alert` for an actionable warning and reroute hint payload
8. Foreground clients show an overlay banner and play a short cue. Background clients receive a push notification.
9. Driver progress updates keep the active route state fresh and prevent stale alerts.
10. On `rerouteSuggestion`, client calls `POST /reroute-options` with origin/destination and avoid-zone from the alert.
11. Backend returns ranked route alternatives that avoid the ambulance intersection zone when possible.

## Event Protocol

### Ambulance ingress

```json
{
  "type": "ambulance.location",
  "ambulanceId": "amb-204",
  "position": {
    "lat": 28.6129,
    "lng": 77.2295,
    "heading": 102,
    "speedMps": 16.2,
    "timestamp": 1772589600000
  },
  "pathHint": [
    { "lat": 28.6131, "lng": 77.2310 },
    { "lat": 28.6134, "lng": 77.2332 }
  ]
}
```

### Driver route registration

```json
{
  "type": "driver.register_route",
  "sessionId": "sess-19",
  "driverId": "driver-8",
  "platform": "android",
  "appState": "foreground",
  "pushToken": "fcm-token",
  "currentPosition": {
    "lat": 28.6103,
    "lng": 77.2258,
    "heading": 96,
    "speedMps": 12.1,
    "timestamp": 1772589600000
  },
  "route": {
    "routeId": "route-991",
    "polyline": [
      { "lat": 28.6103, "lng": 77.2258 },
      { "lat": 28.6115, "lng": 77.2271 },
      { "lat": 28.6128, "lng": 77.2299 }
    ],
    "etaSeconds": 420
  }
}
```

### Driver alert event

```json
{
  "type": "ambulance.alert",
  "sessionId": "sess-19",
  "ambulanceId": "amb-204",
  "severity": "warning",
  "matchType": "intersection_ahead",
  "message": "Ambulance predicted to intersect your route ahead. Follow alternate route guidance.",
  "distanceMeters": 210,
  "timeToImpactSeconds": 14,
  "position": {
    "lat": 28.6129,
    "lng": 77.2295,
    "heading": 102,
    "speedMps": 16.2,
    "timestamp": 1772589600000
  },
  "predictedIntersection": {
    "point": {
      "lat": 28.6134,
      "lng": 77.2318
    },
    "driverProgressMeters": 1540.2,
    "ambulanceTimeToIntersectionSeconds": 14
  },
  "rerouteSuggestion": {
    "reason": "ambulance_intersection",
    "avoidPoint": {
      "lat": 28.6134,
      "lng": 77.2318
    },
    "avoidRadiusMeters": 160,
    "recommendedWithinSeconds": 30
  }
}
```

### Reroute options request

```json
{
  "origin": { "lat": 28.6103, "lng": 77.2258 },
  "destination": { "lat": 28.5934, "lng": 77.2389 },
  "avoidPoint": { "lat": 28.6134, "lng": 77.2318 },
  "avoidRadiusMeters": 160,
  "alternativeCount": 3
}
```

## Spatial Filtering Logic

### Stage 1: Cheap filtering

- Buffer every active driver route into corridor cells of roughly 250 m grid size
- Index sessions by those cells
- For each ambulance update, build a short predicted trajectory and query only overlapping cells

### Stage 2: Predicted intersection and corridor scoring

- Project the driver and ambulance positions onto the route polyline for shared-corridor checks
- Build a short ambulance trajectory
- Compute explicit segment intersections between:
  - each ambulance trajectory segment
  - each driver route segment
- For each true intersection point:
  - compute driver progress to intersection
  - compute ambulance ETA to intersection
  - trigger only when intersection is ahead of driver and inside bounded lookahead
- Attach reroute hints using an avoid-point and avoid-radius centered at the predicted intersection

### Stage 3: Alert suppression

- Deduplicate alerts for a short cooldown such as 10 seconds
- Escalate severity only if time-to-impact or distance gets materially worse
- Stop sending alerts when the ambulance diverges from the route buffer or the driver route changes

## Google Maps Integration Strategy

### On mobile

- Use Navigation SDK for active turn-by-turn guidance
- Use the underlying Google map for custom ambulance markers
- When `rerouteSuggestion` arrives with an avoid-point zone, request alternate routes and guide drivers away from that zone
- On iOS, use `GMSAdvancedMarker` when `mapCapabilities.contains(.advancedMarkers)` is true
- On Android active-guidance surfaces, prefer standard markers plus a banner overlay; Google currently documents `AdvancedMarkerOptions` in the Navigation SDK reference as not applying to the Navigation SDK
- If your Android app has a non-guidance browse or route-preview map surface, that separate Maps surface can use Advanced Markers with a map ID and runtime capability checks
- Upload a simplified route polyline from the current route for server-side matching

### On server

- Prefer client-provided route geometry from the Navigation SDK session
- Use Roads API snapping only when GPS jitter materially affects route matching
- For new server-side route calculations, prefer Routes API over legacy Directions and Distance Matrix APIs

## Safety Guardrails

- Show alerts only for critical route-relevant conflicts
- Avoid full-screen modals during active navigation
- Use a compact top banner or edge overlay that does not cover turn instructions, lane guidance, compass, or current-location context
- Use a single short cue, not repeated speech loops
- Suppress marker animation and banner churn when the same ambulance remains in the same alert state
- Do not show decorative animation during guidance
- Allow alerts to be muted if platform policy and product requirements permit, while keeping core navigation guidance prioritized

## Rate Limiting, Quotas, and Cost Control

- Do not call Google web services on every ambulance tick
- Cache snapped coordinates for short windows keyed by `ambulanceId + rounded coordinate bucket`
- Keep route upload cadence lower than raw GPS cadence; send on route change and periodically on progress checkpoints
- Prefer client-side navigation geometry already produced by the Navigation SDK instead of repeated route recomputation
- If you still depend on legacy Directions or Distance Matrix APIs, meter them tightly and plan migration to Routes API
- Monitor:
  - active driver sessions
  - ambulance updates per second
  - candidate sessions per ambulance update
  - alerts emitted per minute
  - Roads or Routes request volume

## Operational Defaults

- Ambulance state TTL in Redis: 15 seconds
- Driver session stale timeout: 120 seconds
- Route corridor width: 60 to 120 meters depending on road type and GPS quality
- Trajectory projection horizon: 30 to 60 seconds
- Alert cooldown per ambulance/session pair: 10 seconds
