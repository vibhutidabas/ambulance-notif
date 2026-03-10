# Ambulance Alert System

Reference implementation and architecture for a real-time ambulance alert system that integrates with Google Maps-based navigation.

## What is in this repo

- [`docs/architecture.md`](./docs/architecture.md): architecture diagram description, data flow, safety guardrails, and quota strategy
- [`docs/emulator-run.md`](./docs/emulator-run.md): end-to-end local run guide for backend, simulator, and emulator wiring
- [`backend/`](./backend): TypeScript backend scaffold for WebSocket ingestion, route registration, spatial matching, Redis-backed ambulance state, and event fanout
- [`mobile/android/`](./mobile/android): Android snippets for Navigation SDK, marker updates, WebSocket subscription, and alert overlays
- [`mobile/ios/`](./mobile/ios): iOS snippets for Navigation SDK, Advanced Markers, socket subscription, and alert banners

## System goals

- Ingest ambulance GPS updates at 1 to 2 Hz with low end-to-end latency
- Match ambulance motion to driver routes with route buffering and projected path checks
- Show only relevant in-navigation alerts
- Use Google Maps rendering and navigation on-device while keeping server-side geospatial filtering efficient

## Backend quick start

```bash
cd backend
npm install
Copy-Item .env.example .env
npm run dev
```

The backend exposes:

- `GET /healthz`
- `WS /ws/ambulances` for live ambulance location ingestion
- `WS /ws/drivers` for route registration, progress updates, and alert delivery
- `POST /reroute-options` for alternate route suggestions around predicted ambulance intersection zones

Detailed setup, simulation, and tests are documented in [`backend/README.md`](./backend/README.md).

## Run this in a real app later

Use this checklist when you move from demo/simulator to an actual Android/iOS app.

### 1. Run backend API

Local dev:

```powershell
cd C:\Users\vibhu\OneDrive\Desktop\ambulance\backend
npm install
Copy-Item .env.example .env
$env:PORT='8080'
npm run dev
```

Production process:

```powershell
cd C:\Users\vibhu\OneDrive\Desktop\ambulance\backend
npm run build
npm run start
```

### 2. Point your mobile app to backend

- Android emulator: `http://10.0.2.2:8080` and `ws://10.0.2.2:8080`
- iOS simulator: `http://127.0.0.1:8080` and `ws://127.0.0.1:8080`
- Physical phone: use your laptop LAN IP or deployed backend domain (`https://...`, `wss://...`)

### 3. Wire runtime event flow in app

1. Start navigation route in app.
2. Send `driver.register_route` with current route polyline.
3. Send `driver.progress` updates at steady cadence (about 1 Hz).
4. Listen for `ambulance.marker` and `ambulance.alert`.
5. On `rerouteSuggestion`, call `POST /reroute-options` and show alternate routes.
6. Keep alerts minimal and navigation-safe (banner + short cue).

### 4. Production readiness checklist

- Use TLS (`https`/`wss`) and authenticated sockets.
- Enable Redis in `.env` for shared state in multi-instance backend.
- Configure push delivery (FCM/APNs) for background alerts.
- Set `GOOGLE_MAPS_API_KEY` and enable Routes API.
- Add observability (request logs, alert metrics, error tracking).

## Notes on Google Maps APIs

This design uses the Google Maps Navigation SDKs on device for live navigation and map rendering, and uses server-side route geometry plus optional Roads snapping for spatial matching. As of March 4, 2026, Google documents both the Directions API and Distance Matrix API as legacy products; for new server-side route and matrix work, prefer the current Routes API while supporting legacy endpoints only if you already depend on them.

One implementation caveat matters on Android: Google's current `AdvancedMarkerOptions` reference under the Navigation SDK says it does not apply to the Navigation SDK. The reference code in this repo therefore uses standard markers on Android guidance screens and keeps Advanced Markers as an iOS or non-guidance Android map option.
