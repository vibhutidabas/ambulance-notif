# Running Backend, Simulation, and Emulator

## 1. Start backend

```powershell
cd C:\Users\vibhu\OneDrive\Desktop\ambulance\backend
npm install
Copy-Item .env.example .env
```

Set your Google key in `backend\.env` to enable rerouting:

```text
GOOGLE_MAPS_API_KEY=YOUR_KEY
```

Start server:

```powershell
npm run dev
```

## 2. Start traffic simulation

Open a second terminal:

```powershell
cd C:\Users\vibhu\OneDrive\Desktop\ambulance\backend
$env:SIM_DURATION_SECONDS=180
$env:SIM_AMBULANCE_TICK_MS=300
npm run sim
```

This produces live `ambulance.alert` events and reroute suggestions.

## 3. Deterministic demo scenario (3 drivers + 1 ambulance + live viewer)

Use this when you need a controlled demo with visible actions:

- Driver A and Driver B are already on the ambulance corridor.
- Driver C is on a crossing route and receives reroute options.

Open a second terminal and run:

```powershell
cd C:\Users\vibhu\OneDrive\Desktop\ambulance\backend
$env:PORT=8081
npm run dev
```

Open a second terminal and run:

```powershell
cd C:\Users\vibhu\OneDrive\Desktop\ambulance\backend
$env:BACKEND_WS_BASE='ws://localhost:8081'
$env:DEMO_DURATION_SECONDS=180
$env:DEMO_TICK_MS=500
$env:DEMO_ENABLE_REROUTE_REQUESTS='false'
$env:DEMO_USE_FAKE_REROUTE='true'
npm run demo:scenario
```

Then open:

```text
http://localhost:8080
```

For Google-backed reroute options instead of fake demo options:

```powershell
$env:DEMO_ENABLE_REROUTE_REQUESTS='true'
$env:DEMO_USE_FAKE_REROUTE='false'
```

And set in `backend\.env`:

```text
GOOGLE_MAPS_API_KEY=YOUR_KEY
```

## 4. Test reroute API directly

From a third terminal:

```powershell
Invoke-RestMethod -Uri http://localhost:8080/reroute-options -Method Post -ContentType "application/json" -Body '{
  "origin": {"lat": 12.9716, "lng": 77.5946},
  "destination": {"lat": 12.9352, "lng": 77.6245},
  "avoidPoint": {"lat": 12.961, "lng": 77.607},
  "avoidRadiusMeters": 160,
  "alternativeCount": 3
}'
```

## 5. Android emulator flow

Prerequisites:

- Android Studio + Android Emulator
- Google Maps API key + Navigation SDK enabled project

Steps:

1. Create an Android app project in Android Studio.
2. Add your map/navigation setup and include the provided snippet files from `mobile/android/`.
3. Set backend URL to `http://10.0.2.2:8081` and WebSocket base to `ws://10.0.2.2:8081`.
4. Start emulator and run the app.
5. Start active navigation in your app and send `driver.register_route`.
6. Keep backend + `npm run demo:scenario` running; alerts and reroute suggestions should appear.

If no alerts appear in the demo viewer:

1. Check `http://localhost:8081/healthz` and verify `"service":"ambulance-alert-backend"`.
2. Ensure backend and viewer are not on the same port.
3. Example alternate port:
   - terminal 1: `$env:PORT=8081; npm run dev`
   - terminal 2: `$env:BACKEND_WS_BASE='ws://localhost:8081'; npm run demo:scenario`

Why `10.0.2.2`:

- Android emulator uses `10.0.2.2` to reach your host machine `localhost`.

## 6. iOS simulator flow

iOS simulator requires macOS + Xcode.

1. Create an iOS app and add Google Maps + Navigation SDK.
2. Integrate `mobile/ios/` snippets.
3. Set backend URL to `http://127.0.0.1:8081` and WebSocket to `ws://127.0.0.1:8081`.
4. Run backend + `npm run demo:scenario` as above.
5. Start navigation and observe alert and reroute callbacks.

## 7. Shell quick reference

Terminal 1 (backend on 8081):

```powershell
cd C:\Users\vibhu\OneDrive\Desktop\ambulance\backend
npm install
Copy-Item .env.example .env -ErrorAction SilentlyContinue
$env:PORT='8081'
npm run dev
```

Terminal 2 (demo simulator + viewer on 8080):

```powershell
cd C:\Users\vibhu\OneDrive\Desktop\ambulance\backend
$env:BACKEND_WS_BASE='ws://localhost:8081'
$env:DEMO_VIEWER_PORT='8080'
$env:DEMO_DURATION_SECONDS='180'
$env:DEMO_TICK_MS='500'
$env:DEMO_ENABLE_REROUTE_REQUESTS='false'
$env:DEMO_USE_FAKE_REROUTE='true'
$env:DEMO_ALERT_CLEAR_TIMEOUT_MS='8000'
npm run demo:scenario
```

Terminal 3 (health + open demo viewer):

```powershell
Invoke-RestMethod http://localhost:8081/healthz
Start-Process "http://localhost:8080"
```

Optional: real reroute mode (instead of fake options):

```powershell
cd C:\Users\vibhu\OneDrive\Desktop\ambulance\backend
$env:BACKEND_WS_BASE='ws://localhost:8081'
$env:DEMO_VIEWER_PORT='8080'
$env:DEMO_ENABLE_REROUTE_REQUESTS='true'
$env:DEMO_USE_FAKE_REROUTE='false'
npm run demo:scenario
```

Stop anything running on port 8080 or 8081:

```powershell
$pid8080 = (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)
if ($pid8080) { Stop-Process -Id $pid8080 -Force }
$pid8081 = (Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)
if ($pid8081) { Stop-Process -Id $pid8081 -Force }
```
