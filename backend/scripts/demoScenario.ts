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
    response.end(renderViewerHtml());
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
