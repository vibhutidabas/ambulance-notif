# Backend Setup, Simulation, and Tests

## 1. Install prerequisites

- Node.js 22+ and npm
- Redis 7+ (recommended for realistic state behavior)

Optional Redis with Docker:

```bash
docker run --name ambulance-redis -p 6379:6379 -d redis:7
```

To enable Google Routes API powered rerouting:

- Set `GOOGLE_MAPS_API_KEY` in `.env`
- Ensure Routes API is enabled on the same Google Cloud project

## 2. Install backend dependencies

```bash
cd backend
npm install
Copy-Item .env.example .env
```

Redis is optional for local testing. By default, `.env.example` keeps `REDIS_URL` commented out and the backend uses an in-memory fallback.

## 3. Start the backend

```bash
npm run dev
```

Expected:

- `GET http://localhost:8080/healthz`
- `WS ws://localhost:8080/ws/drivers`
- `WS ws://localhost:8080/ws/ambulances`
- `POST http://localhost:8080/reroute-options`

Reroute request example:

```json
{
  "origin": { "lat": 12.9716, "lng": 77.5946 },
  "destination": { "lat": 12.9352, "lng": 77.6245 },
  "avoidPoint": { "lat": 12.961, "lng": 77.607 },
  "avoidRadiusMeters": 160,
  "alternativeCount": 3
}
```

The backend calls Routes API, scores alternatives against the avoid-zone, and returns ranked routes with `recommended=true` on the best option.

## 4. Run traffic simulation

In a second terminal:

```bash
cd backend
npm run sim
```

The simulator registers one driver route, streams driver progress, streams one ambulance at a faster cadence, and prints alert events.
It first checks `GET /healthz` so you can catch wrong-port or wrong-service issues quickly.

Simulation env overrides:

- `BACKEND_WS_BASE` (default: `ws://localhost:8080`)
- `SIM_DURATION_SECONDS` (default: `90`)
- `SIM_DRIVER_TICK_MS` (default: `1000`)
- `SIM_AMBULANCE_TICK_MS` (default: `500`)

Example:

```bash
$env:SIM_DURATION_SECONDS=120
$env:SIM_AMBULANCE_TICK_MS=300
npm run sim
```

If you see WebSocket protocol errors such as `RSV1 must be clear`, it usually means your simulator is connecting to a different service on that port. Verify:

- `GET http://localhost:8080/healthz` returns `service: ambulance-alert-backend`
- `npm run dev` is running from this repo's `backend` folder

## 5. Run deterministic demo scenario (3 drivers + 1 ambulance + visual viewer)

Use this for a clean presentation flow:

- Driver A and Driver B are already on the ambulance route corridor.
- Driver C is on a crossing route and will receive reroute options.

```bash
cd backend
$env:PORT=8081
npm run dev
```

In a second terminal:

```bash
cd backend
$env:BACKEND_WS_BASE='ws://localhost:8081'
$env:DEMO_DURATION_SECONDS=180
$env:DEMO_TICK_MS=500
$env:DEMO_ENABLE_REROUTE_REQUESTS='false'
$env:DEMO_USE_FAKE_REROUTE='true'
npm run demo:scenario
```

Open `http://localhost:8080` to watch the live scenario.

To call real Google reroute options:

```bash
$env:DEMO_ENABLE_REROUTE_REQUESTS='true'
$env:DEMO_USE_FAKE_REROUTE='false'
```

And set `GOOGLE_MAPS_API_KEY` in `.env`.

If alerts do not appear:

1. Verify `http://localhost:8081/healthz` returns `"service":"ambulance-alert-backend"` when using the demo commands above.
2. Check if port 8081 is occupied:
   - `Get-NetTCPConnection -LocalPort 8081 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess`
3. Stop conflicting process or run backend on another port:
   - terminal 1: `$env:PORT=8081; npm run dev`
   - terminal 2: `$env:BACKEND_WS_BASE='ws://localhost:8081'; npm run demo:scenario`

## 6. Run tests

```bash
cd backend
npm test
```

Watch mode:

```bash
npm run test:watch
```

Current test coverage:

- `test/spatialMatcher.test.ts` for rear-approach, intersection-ahead, and non-match behavior

## 7. Suggested next tests

1. `alertEngine` cooldown and deduplication tests.
2. `driverSessionRegistry` index and stale-session pruning tests.
3. WebSocket transport tests with malformed payload handling and ack/error expectations.
