import http from "http";
import WebSocket from "ws";

type LatLng = { lat: number; lng: number };

interface DriverActor {
  sessionId: string;
  driverId: string;
  label: string;
  color: string;
  routeId: string;
  route: LatLng[];
  routeDistances: number[];
  routeLengthMeters: number;
  progressMeters: number;
  speedMps: number;
  ws?: WebSocket;
  latestAlert?: {
    severity: string;
    message: string;
    matchType: string;
    distanceMeters: number;
    timeToImpactSeconds: number;
    rerouteSuggestion?: {
      reason: string;
      avoidPoint: LatLng;
      avoidRadiusMeters: number;
      recommendedWithinSeconds: number;
    };
  };
  rerouteOptions?: Array<{
    id: string;
    durationSeconds: number;
    distanceMeters: number;
    recommended: boolean;
    intersectsAvoidZone: boolean;
  }>;
  lastAlertAtMs?: number;
  lastConflictSeenAtMs?: number;
}

interface AmbulanceActor {
  ambulanceId: string;
  route: LatLng[];
  routeDistances: number[];
  routeLengthMeters: number;
  progressMeters: number;
  speedMps: number;
  ws?: WebSocket;
}

const backendWsBase = process.env.BACKEND_WS_BASE ?? "ws://localhost:8080";
const backendHttpBase = wsToHttpBase(backendWsBase);
const viewerPort = Number(process.env.DEMO_VIEWER_PORT ?? 8080);
const tickMs = Number(process.env.DEMO_TICK_MS ?? 500);
const durationSeconds = Number(process.env.DEMO_DURATION_SECONDS ?? 240);
const enableRerouteRequests =
  String(process.env.DEMO_ENABLE_REROUTE_REQUESTS).toLowerCase() === "true";
const useFakeReroute =
  String(process.env.DEMO_USE_FAKE_REROUTE ?? "true").toLowerCase() !== "false";
const alertClearTimeoutMs = Number(process.env.DEMO_ALERT_CLEAR_TIMEOUT_MS ?? 8000);

const sharedRoute: LatLng[] = [
  { lat: 51.5079, lng: -0.1302 },
  { lat: 51.5077, lng: -0.1288 },
  { lat: 51.5075, lng: -0.1273 },
  { lat: 51.5074, lng: -0.1256 },
  { lat: 51.5075, lng: -0.124 },
  { lat: 51.5078, lng: -0.1223 }
];

const crossingRoute: LatLng[] = [
  { lat: 51.5058, lng: -0.1268 },
  { lat: 51.5068, lng: -0.126 },
  { lat: 51.5079, lng: -0.1252 },
  { lat: 51.507, lng: -0.1243 },
  { lat: 51.5082, lng: -0.1235 },
  { lat: 51.509, lng: -0.1227 }
];

const ambulanceRoute: LatLng[] = [
  { lat: 51.5081, lng: -0.131 },
  { lat: 51.5078, lng: -0.1292 },
  { lat: 51.5076, lng: -0.1274 },
  { lat: 51.5075, lng: -0.1257 },
  { lat: 51.5076, lng: -0.124 },
  { lat: 51.5079, lng: -0.1224 },
  { lat: 51.5085, lng: -0.1214 },
  { lat: 51.5092, lng: -0.1202 }
];

const drivers: DriverActor[] = [
  createDriver("driver-1", "Driver A", "#1E88E5", "shared", sharedRoute, 280, 8),
  createDriver("driver-2", "Driver B", "#43A047", "shared", sharedRoute, 430, 7.5),
  createDriver("driver-3", "Driver C", "#F9A825", "crossing", crossingRoute, 90, 6.2)
];

const ambulance: AmbulanceActor = {
  ambulanceId: "demo-ambulance-1",
  route: ambulanceRoute,
  routeDistances: cumulativeDistances(ambulanceRoute),
  routeLengthMeters: routeLength(ambulanceRoute),
  progressMeters: 120,
  speedMps: 15
};

const logs: string[] = [];
const sseClients = new Set<http.ServerResponse>();
let tickTimer: NodeJS.Timeout | null = null;
let stopTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

const viewerServer = http.createServer((request, response) => {
  if (request.url === "/events") {
    setupSse(response);
    return;
  }

  if (request.url === "/" || request.url === "/index.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(renderViewerHtmlV2());
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not Found");
});

async function main(): Promise<void> {
  assertPortConfig();
  await assertBackendHealth();
  viewerServer.listen(viewerPort, () => {
    console.log(`[demo] Viewer: http://localhost:${viewerPort}`);
    console.log(
      `[demo] Backend WS base: ${backendWsBase} | rerouteRequests=${enableRerouteRequests} | fakeReroute=${useFakeReroute}`
    );
  });

  await Promise.all(drivers.map((driver) => connectDriver(driver)));
  await connectAmbulance();

  startLoop();
}

function assertPortConfig(): void {
  try {
    const backendUrl = new URL(backendHttpBase);
    const backendPort = Number(backendUrl.port || (backendUrl.protocol === "https:" ? 443 : 80));
    const sameHost =
      backendUrl.hostname === "localhost" ||
      backendUrl.hostname === "127.0.0.1" ||
      backendUrl.hostname === "::1";
    if (sameHost && backendPort === viewerPort) {
      throw new Error(
        `Port conflict: backend (${backendHttpBase}) and demo viewer both use ${viewerPort}. Run backend on another port (for example PORT=8081 with BACKEND_WS_BASE=ws://localhost:8081) or set DEMO_VIEWER_PORT.`
      );
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid BACKEND_WS_BASE: ${backendWsBase}`);
    }
    throw error;
  }
}

function startLoop(): void {
  let lastTickAt = Date.now();

  tickTimer = setInterval(() => {
    const now = Date.now();
    const deltaSeconds = Math.max(0.05, (now - lastTickAt) / 1000);
    lastTickAt = now;

    updateDrivers(deltaSeconds);
    updateAmbulance(deltaSeconds);
    clearResolvedAlerts(now);
    broadcastState();
  }, tickMs);

  stopTimer = setTimeout(() => {
    void shutdown("duration elapsed");
  }, durationSeconds * 1000);
}

function updateDrivers(deltaSeconds: number): void {
  for (const driver of drivers) {
    driver.progressMeters = Math.min(
      driver.routeLengthMeters - 8,
      driver.progressMeters + driver.speedMps * deltaSeconds
    );
    const { point, bearing } = pointAlongRoute(
      driver.route,
      driver.routeDistances,
      driver.progressMeters
    );

    if (driver.ws?.readyState === WebSocket.OPEN) {
      driver.ws.send(
        JSON.stringify({
          type: "driver.progress",
          sessionId: driver.sessionId,
          appState: "foreground",
          currentPosition: {
            lat: point.lat,
            lng: point.lng,
            heading: bearing,
            speedMps: driver.speedMps,
            timestamp: Date.now()
          }
        })
      );
    }
  }
}

function updateAmbulance(deltaSeconds: number): void {
  ambulance.progressMeters = Math.min(
    ambulance.routeLengthMeters - 6,
    ambulance.progressMeters + ambulance.speedMps * deltaSeconds
  );
  const current = pointAlongRoute(
    ambulance.route,
    ambulance.routeDistances,
    ambulance.progressMeters
  );
  const hintOne = pointAlongRoute(
    ambulance.route,
    ambulance.routeDistances,
    Math.min(ambulance.routeLengthMeters, ambulance.progressMeters + 80)
  ).point;
  const hintTwo = pointAlongRoute(
    ambulance.route,
    ambulance.routeDistances,
    Math.min(ambulance.routeLengthMeters, ambulance.progressMeters + 180)
  ).point;

  if (ambulance.ws?.readyState === WebSocket.OPEN) {
    ambulance.ws.send(
      JSON.stringify({
        type: "ambulance.location",
        ambulanceId: ambulance.ambulanceId,
        position: {
          lat: current.point.lat,
          lng: current.point.lng,
          heading: current.bearing,
          speedMps: ambulance.speedMps,
          timestamp: Date.now()
        },
        pathHint: [hintOne, hintTwo]
      })
    );
  }
}

async function connectDriver(driver: DriverActor): Promise<void> {
  const socket = new WebSocket(`${backendWsBase}/ws/drivers`, {
    perMessageDeflate: false
  });
  driver.ws = socket;

  await waitForOpen(socket);
  const start = pointAlongRoute(driver.route, driver.routeDistances, driver.progressMeters);
  socket.send(
    JSON.stringify({
      type: "driver.register_route",
      sessionId: driver.sessionId,
      driverId: driver.driverId,
      platform: "android",
      appState: "foreground",
      currentPosition: {
        lat: start.point.lat,
        lng: start.point.lng,
        heading: start.bearing,
        speedMps: driver.speedMps,
        timestamp: Date.now()
      },
      route: {
        routeId: driver.routeId,
        polyline: driver.route
      }
    })
  );

  socket.on("message", (raw) => {
    const payload = safeParse(raw.toString());
    if (!payload) {
      return;
    }

    if (payload.type === "ambulance.alert") {
      const now = Date.now();
      driver.latestAlert = {
        severity: String(payload.severity ?? "unknown"),
        message: String(payload.message ?? ""),
        matchType: String(payload.matchType ?? "unknown"),
        distanceMeters: Number(payload.distanceMeters ?? 0),
        timeToImpactSeconds: Number(payload.timeToImpactSeconds ?? 0),
        rerouteSuggestion: parseRerouteSuggestion(payload.rerouteSuggestion)
      };
      driver.lastAlertAtMs = now;
      driver.lastConflictSeenAtMs = now;
      addLog(
        `${driver.label}: ${driver.latestAlert.severity.toUpperCase()} ${driver.latestAlert.matchType} (${driver.latestAlert.distanceMeters}m / ${driver.latestAlert.timeToImpactSeconds}s)`
      );

      if (
        driver.driverId === "driver-3" &&
        driver.latestAlert.rerouteSuggestion
      ) {
        void handleRerouteForDriver(driver);
      }
      broadcastState();
      return;
    }

    if (payload.type === "ambulance.marker") {
      const status = String(payload.status ?? "");
      if (status === "shared_corridor" || status === "projected_conflict") {
        driver.lastConflictSeenAtMs = Date.now();
      }
    }
  });

  socket.on("error", (error) => {
    addLog(`${driver.label}: socket error ${error.message}`);
  });
}

async function handleRerouteForDriver(driver: DriverActor): Promise<void> {
  if (!driver.latestAlert?.rerouteSuggestion) {
    return;
  }

  if (!enableRerouteRequests) {
    if (useFakeReroute) {
      driver.rerouteOptions = fakeRerouteOptions();
      addLog(`${driver.label}: fake reroute options generated.`);
      broadcastState();
    }
    return;
  }

  const current = pointAlongRoute(
    driver.route,
    driver.routeDistances,
    driver.progressMeters
  ).point;
  const destination = driver.route[driver.route.length - 1];
  const suggestion = driver.latestAlert.rerouteSuggestion;

  try {
    const response = await fetch(`${backendHttpBase}/reroute-options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: current,
        destination,
        avoidPoint: suggestion.avoidPoint,
        avoidRadiusMeters: suggestion.avoidRadiusMeters,
        alternativeCount: 3
      }),
      signal: AbortSignal.timeout(10_000)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !Array.isArray((payload as { routes?: unknown }).routes)) {
      throw new Error(`reroute API error (${response.status})`);
    }

    driver.rerouteOptions = ((payload as { routes: unknown[] }).routes).map((route) => {
      const record = route as Record<string, unknown>;
      return {
        id: String(record.id ?? "route"),
        distanceMeters: Number(record.distanceMeters ?? 0),
        durationSeconds: Number(record.durationSeconds ?? 0),
        recommended: Boolean(record.recommended),
        intersectsAvoidZone: Boolean(record.intersectsAvoidZone)
      };
    });
    addLog(`${driver.label}: reroute options received (${driver.rerouteOptions.length}).`);
    broadcastState();
  } catch (error) {
    addLog(
      `${driver.label}: reroute request failed (${error instanceof Error ? error.message : "unknown error"}).`
    );
    if (useFakeReroute) {
      driver.rerouteOptions = fakeRerouteOptions();
      addLog(`${driver.label}: switched to fake reroute options.`);
      broadcastState();
    }
  }
}

async function connectAmbulance(): Promise<void> {
  const socket = new WebSocket(`${backendWsBase}/ws/ambulances`, {
    perMessageDeflate: false
  });
  ambulance.ws = socket;
  await waitForOpen(socket);
  socket.on("error", (error) => {
    addLog(`Ambulance socket error: ${error.message}`);
  });
}

function buildPublicState(): Record<string, unknown> {
  return {
    ts: Date.now(),
    routes: [
      { id: "shared", color: "#1565C0", points: sharedRoute },
      { id: "crossing", color: "#F9A825", points: crossingRoute },
      { id: "ambulance", color: "#D32F2F", points: ambulanceRoute }
    ],
    ambulance: {
      id: ambulance.ambulanceId,
      ...pointAlongRoute(
        ambulance.route,
        ambulance.routeDistances,
        ambulance.progressMeters
      ).point
    },
    drivers: drivers.map((driver) => ({
      id: driver.driverId,
      label: driver.label,
      color: driver.color,
      routeId: driver.routeId,
      ...pointAlongRoute(driver.route, driver.routeDistances, driver.progressMeters).point,
      latestAlert: driver.latestAlert ?? null,
      rerouteOptions: driver.rerouteOptions ?? []
    })),
    logs: logs.slice(-20)
  };
}

function setupSse(response: http.ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });
  response.write(`data: ${JSON.stringify(buildPublicState())}\n\n`);
  sseClients.add(response);
  response.on("close", () => {
    sseClients.delete(response);
  });
}

function broadcastState(): void {
  const message = `data: ${JSON.stringify(buildPublicState())}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

function renderViewerHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Ambulance Demo Scenario</title>
  <style>
    body { margin: 0; font-family: Segoe UI, sans-serif; background: #0f172a; color: #e2e8f0; }
    .layout { display: grid; grid-template-columns: 2fr 1fr; height: 100vh; }
    canvas { width: 100%; height: 100%; background: #0b1220; }
    .panel { padding: 12px; overflow: auto; border-left: 1px solid #1e293b; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
    .log { font-size: 12px; line-height: 1.4; color: #cbd5e1; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 999px; font-size: 11px; margin-right: 6px; }
    .critical { background: #7f1d1d; color: #fecaca; }
    .warning { background: #78350f; color: #fde68a; }
    .info { background: #1e3a8a; color: #bfdbfe; }
  </style>
</head>
<body>
  <div class="layout">
    <canvas id="mapCanvas" width="1100" height="760"></canvas>
    <div class="panel">
      <div class="card"><strong>Demo Scenario</strong><br/>2 drivers on ambulance corridor, 1 crossing driver on a multi-intersection route receives reroute guidance.</div>
      <div id="drivers"></div>
      <div class="card">
        <strong>Event Log</strong>
        <div id="logs" class="log"></div>
      </div>
    </div>
  </div>
<script>
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
let state = null;
const eventSource = new EventSource("/events");
eventSource.onmessage = (event) => {
  state = JSON.parse(event.data);
  render();
};

function render() {
  if (!state) return;
  const allPoints = [];
  for (const route of state.routes) allPoints.push(...route.points);
  allPoints.push({lat: state.ambulance.lat, lng: state.ambulance.lng});
  for (const d of state.drivers) allPoints.push({lat: d.lat, lng: d.lng});
  const bounds = computeBounds(allPoints);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid(bounds);

  for (const route of state.routes) {
    const isAmb = route.id === "ambulance";
    drawPolyline(route.points, route.color, isAmb ? [8, 6] : []);
  }

  for (const d of state.drivers) {
    drawMarker(d.lat, d.lng, d.color, d.label);
  }
  drawMarker(state.ambulance.lat, state.ambulance.lng, "#ef4444", "Ambulance");

  const driversEl = document.getElementById("drivers");
  driversEl.innerHTML = state.drivers.map((driver) => {
    const alert = driver.latestAlert;
    const badge = alert ? '<span class="badge ' + alert.severity + '">' + alert.severity + '</span>' : '';
    const alertLine = alert ? '<div>' + badge + alert.matchType + ' • ' + alert.distanceMeters + 'm • ' + alert.timeToImpactSeconds + 's</div>' : '<div>No active alert</div>';
    const reroutes = (driver.rerouteOptions || []).map((r) => '<div>Route ' + r.id + ': ' + r.durationSeconds + 's / ' + r.distanceMeters + 'm' + (r.recommended ? ' (recommended)' : '') + '</div>').join('');
    return '<div class="card"><strong>' + driver.label + '</strong>' + alertLine + (reroutes ? '<hr/><div><strong>Reroute options</strong></div>' + reroutes : '') + '</div>';
  }).join('');

  const logsEl = document.getElementById("logs");
  logsEl.innerHTML = state.logs.map((line) => '<div>' + escapeHtml(line) + '</div>').join('');

  function drawGrid(bounds) {
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 1;
    for (let x = 0; x <= 12; x++) {
      const px = (x / 12) * canvas.width;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= 8; y++) {
      const py = (y / 8) * canvas.height;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(canvas.width, py);
      ctx.stroke();
    }
  }

  function drawPolyline(points, color, dash) {
    if (!points.length) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.setLineDash(dash);
    ctx.beginPath();
    const first = toScreen(points[0]);
    ctx.moveTo(first.x, first.y);
    for (const p of points.slice(1)) {
      const s = toScreen(p);
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawMarker(lat, lng, color, label) {
    const p = toScreen({lat, lng});
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f8fafc";
    ctx.font = "12px Segoe UI";
    ctx.fillText(label, p.x + 10, p.y - 10);
  }

  function toScreen(point) {
    const pad = 30;
    const x = ((point.lng - bounds.minLng) / (bounds.maxLng - bounds.minLng || 1)) * (canvas.width - pad * 2) + pad;
    const y = ((bounds.maxLat - point.lat) / (bounds.maxLat - bounds.minLat || 1)) * (canvas.height - pad * 2) + pad;
    return {x, y};
  }
}

function computeBounds(points) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  const latPad = (maxLat - minLat || 0.001) * 0.18;
  const lngPad = (maxLng - minLng || 0.001) * 0.18;
  return { minLat: minLat - latPad, maxLat: maxLat + latPad, minLng: minLng - lngPad, maxLng: maxLng + lngPad };
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, function(m) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[m];
  });
}
</script>
</body>
</html>`;
}

function renderViewerHtmlV2(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ambulance Demo Scenario</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #081120;
      --panel: #0f1f35;
      --panel-border: #2a4369;
      --text: #e8f0ff;
      --muted: #9fb5d8;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      font-family: "Space Grotesk", "Segoe UI", sans-serif;
      background:
        radial-gradient(900px 560px at 85% 0%, rgba(37, 99, 235, 0.18), transparent 60%),
        radial-gradient(800px 500px at 8% 100%, rgba(8, 145, 178, 0.18), transparent 58%),
        linear-gradient(160deg, #08101d 0%, #0c1629 45%, #0a1324 100%);
    }

    .layout {
      height: 100vh;
      display: grid;
      grid-template-columns: minmax(620px, 2.2fr) minmax(340px, 1fr);
      gap: 14px;
      padding: 14px;
    }

    .map-shell {
      position: relative;
      border: 1px solid #284065;
      border-radius: 16px;
      overflow: hidden;
      background: #0a1629;
      box-shadow: 0 24px 40px rgba(0, 0, 0, 0.34);
    }

    #mapCanvas {
      width: 100%;
      height: 100%;
      display: block;
    }

    .map-top {
      position: absolute;
      z-index: 5;
      top: 12px;
      left: 12px;
      display: flex;
      gap: 8px;
    }

    .chip {
      border: 1px solid #35557f;
      border-radius: 999px;
      padding: 6px 12px;
      background: rgba(9, 20, 37, 0.84);
      color: #dbe8ff;
      font-size: 12px;
      backdrop-filter: blur(4px);
    }

    .legend {
      position: absolute;
      z-index: 5;
      top: 12px;
      right: 12px;
      border: 1px solid #335179;
      border-radius: 12px;
      padding: 9px 12px;
      background: rgba(9, 20, 37, 0.84);
      color: #d6e3fb;
      font-size: 12px;
      display: grid;
      gap: 6px;
      backdrop-filter: blur(4px);
    }

    .legend-row { display: flex; align-items: center; gap: 8px; }

    .dot {
      width: 11px;
      height: 11px;
      border-radius: 999px;
      display: inline-block;
    }

    .panel {
      border: 1px solid var(--panel-border);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(15, 31, 53, 0.96), rgba(11, 24, 42, 0.96));
      padding: 13px;
      box-shadow: 0 20px 32px rgba(0, 0, 0, 0.26);
      overflow: auto;
    }

    .title { margin: 0; font-size: 22px; font-weight: 700; }
    .subtitle { margin: 6px 0 12px 0; color: var(--muted); font-size: 13px; line-height: 1.45; }

    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }

    .stat {
      border: 1px solid #304d76;
      border-radius: 12px;
      background: rgba(13, 26, 45, 0.78);
      padding: 9px;
    }

    .stat-label { font-size: 11px; letter-spacing: 0.03em; text-transform: uppercase; color: #a7bcde; }
    .stat-value { margin-top: 5px; font-size: 22px; font-weight: 700; line-height: 1; }

    .section-title {
      margin: 0 0 8px 0;
      font-size: 12px;
      color: #c9d9f2;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }

    .card {
      border: 1px solid #2b466b;
      border-radius: 12px;
      background: rgba(13, 25, 43, 0.88);
      padding: 10px 12px;
      margin-bottom: 8px;
    }

    .driver-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      font-size: 14px;
      font-weight: 600;
    }

    .badge {
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border: 1px solid transparent;
    }

    .sev-critical { color: #ffd2d2; background: rgba(127, 29, 29, 0.72); border-color: rgba(239, 68, 68, 0.52); }
    .sev-warning { color: #ffe6c4; background: rgba(120, 53, 15, 0.72); border-color: rgba(245, 158, 11, 0.52); }
    .sev-info { color: #d4e8ff; background: rgba(30, 58, 138, 0.72); border-color: rgba(96, 165, 250, 0.52); }
    .sev-none { color: #c2d6f2; background: rgba(30, 41, 59, 0.75); border-color: rgba(148, 163, 184, 0.35); }

    .driver-line { font-size: 12px; line-height: 1.45; color: #dae7fc; }
    .driver-meta { margin-top: 4px; font-size: 11px; color: #9fb5d8; font-family: "JetBrains Mono", ui-monospace, monospace; }

    .routes {
      margin-top: 8px;
      border-top: 1px solid #2b466c;
      padding-top: 8px;
    }

    .route-line { font-size: 11px; color: #c7d9f5; line-height: 1.44; }

    .logs {
      margin-top: 8px;
      border: 1px solid #2b466c;
      border-radius: 12px;
      background: rgba(9, 19, 34, 0.76);
      padding: 8px 10px;
      max-height: 230px;
      overflow: auto;
    }

    .log-line {
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 11px;
      color: #a7c0e3;
      line-height: 1.48;
      padding: 2px 0;
      border-bottom: 1px dashed rgba(66, 94, 133, 0.42);
    }

    .log-line:last-child { border-bottom: none; }
    .foot { margin-top: 10px; font-size: 11px; color: #88a3ca; }

    @media (max-width: 1180px) {
      .layout { grid-template-columns: 1fr; height: auto; min-height: 100vh; }
      .map-shell { min-height: 62vh; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <section class="map-shell">
      <canvas id="mapCanvas" width="1280" height="820"></canvas>
      <div class="map-top">
        <span class="chip">Live Scenario</span>
        <span class="chip">3 drivers + 1 ambulance</span>
      </div>
      <div class="legend">
        <div class="legend-row"><span class="dot" style="background:#ef4444"></span>Ambulance</div>
        <div class="legend-row"><span class="dot" style="background:#3b82f6"></span>Shared corridor</div>
        <div class="legend-row"><span class="dot" style="background:#f59e0b"></span>Crossing route</div>
      </div>
    </section>
    <aside class="panel">
      <h1 class="title">Ambulance Conflict Monitor</h1>
      <p class="subtitle">Real-time route conflict tracking with reroute hints and auto-clear once the ambulance passes.</p>
      <div id="stats" class="stats"></div>
      <h2 class="section-title">Driver Sessions</h2>
      <div id="drivers"></div>
      <h2 class="section-title">Event Stream</h2>
      <div id="logs" class="logs"></div>
      <div class="foot">Tip: Driver C usually receives reroute options near crossing intersections.</div>
    </aside>
  </div>

<script>
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const statsEl = document.getElementById("stats");
const driversEl = document.getElementById("drivers");
const logsEl = document.getElementById("logs");
let state = null;
const history = new Map();
let pulse = 0;

const eventSource = new EventSource("/events");
eventSource.onmessage = (event) => {
  try {
    state = JSON.parse(event.data);
    trackHistory(state);
    renderSidePanel(state);
  } catch (_) {}
};

eventSource.onerror = () => {
  logsEl.innerHTML = '<div class="log-line">event stream disconnected, retrying...</div>' + logsEl.innerHTML;
};

requestAnimationFrame(drawFrame);

function drawFrame(ts) {
  pulse = (Math.sin(ts / 350) + 1) / 2;
  renderMap();
  requestAnimationFrame(drawFrame);
}

function renderMap() {
  if (!state) {
    drawIdle();
    return;
  }

  const points = collectPoints(state);
  const bounds = computeBounds(points);
  const project = makeProjector(bounds);

  drawBackground(bounds);
  drawTrails(project);

  for (const route of state.routes) {
    drawRoute(route, project);
  }

  for (const driver of state.drivers) {
    drawDriver(driver, project);
  }
  drawAmbulance(state.ambulance, project);
}

function drawIdle() {
  const bg = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  bg.addColorStop(0, "#0a162a");
  bg.addColorStop(1, "#091224");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#9eb4d8";
  ctx.font = "600 20px Space Grotesk";
  ctx.fillText("Waiting for simulation stream...", 40, 58);
}

function drawBackground(bounds) {
  const bg = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  bg.addColorStop(0, "#0a162a");
  bg.addColorStop(1, "#091224");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const glow = ctx.createRadialGradient(canvas.width * 0.72, canvas.height * 0.2, 12, canvas.width * 0.72, canvas.height * 0.2, 520);
  glow.addColorStop(0, "rgba(59,130,246,0.15)");
  glow.addColorStop(1, "rgba(59,130,246,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(70,99,140,0.25)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= 16; x++) {
    const px = (x / 16) * canvas.width;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y <= 10; y++) {
    const py = (y / 10) * canvas.height;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(canvas.width, py);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(140,170,212,0.52)";
  ctx.font = "500 12px JetBrains Mono";
  ctx.fillText("NW " + bounds.maxLat.toFixed(4) + ", " + bounds.minLng.toFixed(4), 18, 22);
  ctx.fillText("SE " + bounds.minLat.toFixed(4) + ", " + bounds.maxLng.toFixed(4), 18, 40);
}

function drawRoute(route, project) {
  const isAmbulance = route.id === "ambulance";
  const isCrossing = route.id === "crossing";

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(10,24,43,0.92)";
  ctx.lineWidth = isAmbulance ? 15 : 12;
  drawPolyline(route.points, project);
  ctx.stroke();

  ctx.strokeStyle = route.color;
  ctx.lineWidth = isAmbulance ? 8 : 6;
  ctx.setLineDash(isAmbulance ? [14, 8] : (isCrossing ? [10, 8] : []));
  drawPolyline(route.points, project);
  ctx.stroke();
  ctx.restore();
}

function drawTrails(project) {
  for (const entry of history.entries()) {
    const key = entry[0];
    const points = entry[1];
    if (!points || points.length < 2) {
      continue;
    }
    const isAmb = key.indexOf("ambulance:") === 0;
    ctx.save();
    ctx.lineWidth = isAmb ? 3 : 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = isAmb ? "rgba(255,99,102,0.42)" : "rgba(147,197,253,0.34)";
    ctx.setLineDash(isAmb ? [8, 6] : []);
    drawPolyline(points, project);
    ctx.stroke();
    ctx.restore();
  }
}

function drawDriver(driver, project) {
  const p = project({ lat: driver.lat, lng: driver.lng });
  ctx.save();
  ctx.fillStyle = driver.color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(235,244,255,0.95)";
  ctx.stroke();

  ctx.fillStyle = "rgba(6,15,29,0.88)";
  ctx.strokeStyle = "rgba(84,120,169,0.7)";
  ctx.lineWidth = 1;
  ctx.font = "600 12px Space Grotesk";
  const label = driver.label;
  const w = ctx.measureText(label).width + 16;
  const h = 22;
  ctx.beginPath();
  roundRect(ctx, p.x + 10, p.y - 28, w, h, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#e6effe";
  ctx.fillText(label, p.x + 18, p.y - 13);
  ctx.restore();
}

function drawAmbulance(ambulance, project) {
  const p = project({ lat: ambulance.lat, lng: ambulance.lng });
  const radius = 18 + pulse * 14;

  ctx.save();
  ctx.strokeStyle = "rgba(255,93,95," + (0.42 - pulse * 0.2).toFixed(3) + ")";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,120,122," + (0.25 - pulse * 0.12).toFixed(3) + ")";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius + 12, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#ff4d4f";
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - 12);
  ctx.lineTo(p.x + 10, p.y);
  ctx.lineTo(p.x, p.y + 12);
  ctx.lineTo(p.x - 10, p.y);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,236,236,0.92)";
  ctx.stroke();

  ctx.fillStyle = "#ffe7e7";
  ctx.font = "700 12px JetBrains Mono";
  ctx.fillText("AMB", p.x + 14, p.y + 4);
  ctx.restore();
}

function roundRect(targetCtx, x, y, width, height, radius) {
  targetCtx.moveTo(x + radius, y);
  targetCtx.lineTo(x + width - radius, y);
  targetCtx.quadraticCurveTo(x + width, y, x + width, y + radius);
  targetCtx.lineTo(x + width, y + height - radius);
  targetCtx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  targetCtx.lineTo(x + radius, y + height);
  targetCtx.quadraticCurveTo(x, y + height, x, y + height - radius);
  targetCtx.lineTo(x, y + radius);
  targetCtx.quadraticCurveTo(x, y, x + radius, y);
}

function drawPolyline(points, project) {
  if (!points || points.length === 0) {
    return;
  }
  const first = project(points[0]);
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const p = project(points[i]);
    ctx.lineTo(p.x, p.y);
  }
}

function makeProjector(bounds) {
  return function(point) {
    const pad = 34;
    const x = ((point.lng - bounds.minLng) / (bounds.maxLng - bounds.minLng || 1)) * (canvas.width - pad * 2) + pad;
    const y = ((bounds.maxLat - point.lat) / (bounds.maxLat - bounds.minLat || 1)) * (canvas.height - pad * 2) + pad;
    return { x, y };
  };
}

function collectPoints(snapshot) {
  const points = [];
  for (const route of snapshot.routes) {
    points.push(...route.points);
  }
  points.push({ lat: snapshot.ambulance.lat, lng: snapshot.ambulance.lng });
  for (const d of snapshot.drivers) {
    points.push({ lat: d.lat, lng: d.lng });
  }
  for (const values of history.values()) {
    points.push(...values);
  }
  return points;
}

function trackHistory(snapshot) {
  pushHistory("ambulance:" + snapshot.ambulance.id, { lat: snapshot.ambulance.lat, lng: snapshot.ambulance.lng }, 34);
  for (const d of snapshot.drivers) {
    pushHistory("driver:" + d.id, { lat: d.lat, lng: d.lng }, 26);
  }
}

function pushHistory(key, point, maxPoints) {
  if (!history.has(key)) {
    history.set(key, []);
  }
  const values = history.get(key);
  if (!values) {
    return;
  }
  values.push(point);
  if (values.length > maxPoints) {
    values.shift();
  }
}

function renderSidePanel(snapshot) {
  const drivers = snapshot.drivers || [];
  const activeAlerts = drivers.filter((d) => !!d.latestAlert);
  const criticalCount = activeAlerts.filter((d) => d.latestAlert.severity === "critical").length;
  const rerouteCount = drivers.filter((d) => Array.isArray(d.rerouteOptions) && d.rerouteOptions.length > 0).length;

  statsEl.innerHTML =
    '<div class="stat"><div class="stat-label">Active alerts</div><div class="stat-value">' + activeAlerts.length + '</div></div>' +
    '<div class="stat"><div class="stat-label">Critical</div><div class="stat-value">' + criticalCount + '</div></div>' +
    '<div class="stat"><div class="stat-label">Reroutes</div><div class="stat-value">' + rerouteCount + '</div></div>';

  driversEl.innerHTML = drivers.map((d) => renderDriverCard(d)).join('');
  const logs = (snapshot.logs || []).slice().reverse();
  logsEl.innerHTML = logs.map((line) => '<div class="log-line">' + escapeHtml(line) + '</div>').join('');
}

function renderDriverCard(driver) {
  const alert = driver.latestAlert;
  const severity = alert ? String(alert.severity || "info") : "none";
  const badge = '<span class="badge sev-' + severity + '">' + (alert ? escapeHtml(severity) : 'clear') + '</span>';
  const line = alert
    ? '<div class="driver-line">' + escapeHtml(String(alert.message || "Ambulance conflict detected.")) + '</div>'
    : '<div class="driver-line">No active ambulance conflict on current path.</div>';
  const meta = alert
    ? '<div class="driver-meta">' + escapeHtml(String(alert.matchType || "match")) + ' | ' + Number(alert.distanceMeters || 0) + 'm | ' + Number(alert.timeToImpactSeconds || 0) + 's</div>'
    : '<div class="driver-meta">Monitoring route</div>';

  const reroutes = Array.isArray(driver.rerouteOptions) ? driver.rerouteOptions : [];
  const routeBlock = reroutes.length
    ? '<div class="routes">' + reroutes.map((r) =>
        '<div class="route-line">Route ' + escapeHtml(String(r.id)) + ' | ' + Number(r.durationSeconds || 0) + 's | ' + Number(r.distanceMeters || 0) + 'm' + (r.recommended ? ' | recommended' : '') + '</div>'
      ).join('') + '</div>'
    : '';

  return '' +
    '<div class="card">' +
      '<div class="driver-head"><span>' + escapeHtml(String(driver.label || driver.id || "Driver")) + '</span>' + badge + '</div>' +
      line +
      meta +
      routeBlock +
    '</div>';
}

function computeBounds(points) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points || []) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  if (!Number.isFinite(minLat) || !Number.isFinite(minLng)) {
    return { minLat: 0, maxLat: 1, minLng: 0, maxLng: 1 };
  }
  const latPad = (maxLat - minLat || 0.001) * 0.22;
  const lngPad = (maxLng - minLng || 0.001) * 0.22;
  return { minLat: minLat - latPad, maxLat: maxLat + latPad, minLng: minLng - lngPad, maxLng: maxLng + lngPad };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, function(m) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[m];
  });
}
</script>
</body>
</html>`;
}

function addLog(message: string): void {
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  logs.push(line);
  if (logs.length > 80) {
    logs.shift();
  }
}

function clearResolvedAlerts(nowMs: number): void {
  for (const driver of drivers) {
    if (!driver.latestAlert) {
      continue;
    }

    const lastConflictAt = driver.lastConflictSeenAtMs ?? driver.lastAlertAtMs ?? 0;
    if (lastConflictAt <= 0 || nowMs - lastConflictAt < alertClearTimeoutMs) {
      continue;
    }

    driver.latestAlert = undefined;
    driver.rerouteOptions = [];
    driver.lastAlertAtMs = undefined;
    driver.lastConflictSeenAtMs = undefined;
    addLog(`${driver.label}: alert cleared (ambulance passed or diverged).`);
  }
}

function createDriver(
  id: string,
  label: string,
  color: string,
  routeId: string,
  route: LatLng[],
  progressMeters: number,
  speedMps: number
): DriverActor {
  const distances = cumulativeDistances(route);
  return {
    sessionId: `demo-session-${id}`,
    driverId: id,
    label,
    color,
    routeId,
    route,
    routeDistances: distances,
    routeLengthMeters: distances[distances.length - 1] ?? 0,
    progressMeters,
    speedMps
  };
}

function parseRerouteSuggestion(value: unknown): DriverActor["latestAlert"]["rerouteSuggestion"] {
  const record = value as Record<string, unknown> | null;
  const avoidPoint = record?.avoidPoint as Record<string, unknown> | undefined;
  if (
    !record ||
    typeof record.reason !== "string" ||
    !avoidPoint ||
    typeof avoidPoint.lat !== "number" ||
    typeof avoidPoint.lng !== "number" ||
    typeof record.avoidRadiusMeters !== "number" ||
    typeof record.recommendedWithinSeconds !== "number"
  ) {
    return undefined;
  }

  return {
    reason: record.reason,
    avoidPoint: { lat: avoidPoint.lat, lng: avoidPoint.lng },
    avoidRadiusMeters: record.avoidRadiusMeters,
    recommendedWithinSeconds: record.recommendedWithinSeconds
  };
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fakeRerouteOptions(): DriverActor["rerouteOptions"] {
  return [
    {
      id: "route-1",
      durationSeconds: 640,
      distanceMeters: 5200,
      recommended: true,
      intersectsAvoidZone: false
    },
    {
      id: "route-2",
      durationSeconds: 690,
      distanceMeters: 5600,
      recommended: false,
      intersectsAvoidZone: false
    },
    {
      id: "route-3",
      durationSeconds: 610,
      distanceMeters: 4900,
      recommended: false,
      intersectsAvoidZone: true
    }
  ];
}

function wsToHttpBase(wsBase: string): string {
  return wsBase.startsWith("wss://")
    ? wsBase.replace(/^wss:\/\//, "https://")
    : wsBase.replace(/^ws:\/\//, "http://");
}

async function assertBackendHealth(): Promise<void> {
  const healthUrl = `${backendHttpBase}/healthz`;
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    if (payload.service !== "ambulance-alert-backend") {
      throw new Error(
        `Unexpected service at ${healthUrl}: ${String(payload.service ?? "unknown")}`
      );
    }
  } catch (error) {
    const details = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `Backend health check failed at ${healthUrl}. Ensure npm run dev is running for this project and port matches BACKEND_WS_BASE. Details: ${details}`
    );
  }
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("open", handleOpen);
      socket.off("error", handleError);
    };

    socket.on("open", handleOpen);
    socket.on("error", handleError);
  });
}

function cumulativeDistances(route: LatLng[]): number[] {
  if (route.length === 0) {
    return [];
  }
  const distances = [0];
  for (let index = 1; index < route.length; index += 1) {
    distances[index] = distances[index - 1] + haversine(route[index - 1], route[index]);
  }
  return distances;
}

function routeLength(route: LatLng[]): number {
  const distances = cumulativeDistances(route);
  return distances[distances.length - 1] ?? 0;
}

function pointAlongRoute(
  route: LatLng[],
  distances: number[],
  progressMeters: number
): { point: LatLng; bearing: number } {
  if (route.length === 1) {
    return { point: route[0], bearing: 0 };
  }

  const clamped = Math.max(0, Math.min(progressMeters, distances[distances.length - 1] ?? 0));
  for (let index = 0; index < route.length - 1; index += 1) {
    const segmentStartDistance = distances[index];
    const segmentEndDistance = distances[index + 1];
    if (clamped <= segmentEndDistance) {
      const segmentLength = Math.max(0.0001, segmentEndDistance - segmentStartDistance);
      const fraction = (clamped - segmentStartDistance) / segmentLength;
      return {
        point: {
          lat: route[index].lat + (route[index + 1].lat - route[index].lat) * fraction,
          lng: route[index].lng + (route[index + 1].lng - route[index].lng) * fraction
        },
        bearing: bearing(route[index], route[index + 1])
      };
    }
  }

  return {
    point: route[route.length - 1],
    bearing: bearing(route[route.length - 2], route[route.length - 1])
  };
}

function haversine(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing(a: LatLng, b: LatLng): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const toDeg = (v: number) => (v * 180) / Math.PI;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  addLog(`Shutting down: ${reason}`);

  if (tickTimer) {
    clearInterval(tickTimer);
  }
  if (stopTimer) {
    clearTimeout(stopTimer);
  }

  for (const driver of drivers) {
    driver.ws?.close(1000, "demo shutdown");
  }
  ambulance.ws?.close(1000, "demo shutdown");

  for (const client of sseClients) {
    client.end();
  }

  viewerServer.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("sigint"));
process.on("SIGTERM", () => void shutdown("sigterm"));

void main().catch((error) => {
  console.error(`[demo] startup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
