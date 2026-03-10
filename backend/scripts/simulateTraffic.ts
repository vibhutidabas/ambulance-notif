import WebSocket from "ws";

type LatLng = { lat: number; lng: number };

const backendWsBase = process.env.BACKEND_WS_BASE ?? "ws://localhost:8080";
const durationSeconds = Number(process.env.SIM_DURATION_SECONDS ?? 90);
const driverTickMs = Number(process.env.SIM_DRIVER_TICK_MS ?? 1000);
const ambulanceTickMs = Number(process.env.SIM_AMBULANCE_TICK_MS ?? 500);

const route: LatLng[] = [
  { lat: 51.5075, lng: -0.1284 },
  { lat: 51.50765, lng: -0.1266 },
  { lat: 51.5078, lng: -0.1248 },
  { lat: 51.50795, lng: -0.123 }
];

const wsOptions = {
  perMessageDeflate: false,
  handshakeTimeout: 5000
};

const interpolate = (start: LatLng, end: LatLng, fraction: number): LatLng => ({
  lat: start.lat + (end.lat - start.lat) * fraction,
  lng: start.lng + (end.lng - start.lng) * fraction
});

const interpolateOnRoute = (fraction: number): LatLng => {
  const clamped = Math.max(0, Math.min(1, fraction));
  const scaled = clamped * (route.length - 1);
  const segmentIndex = Math.min(route.length - 2, Math.floor(scaled));
  const segmentFraction = scaled - segmentIndex;
  return interpolate(route[segmentIndex], route[segmentIndex + 1], segmentFraction);
};

const toHttpBase = (wsBase: string): string =>
  wsBase.startsWith("wss://")
    ? wsBase.replace(/^wss:\/\//, "https://")
    : wsBase.replace(/^ws:\/\//, "http://");

const assertBackendHealth = async (): Promise<void> => {
  const healthUrl = `${toHttpBase(backendWsBase)}/healthz`;
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5000)
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
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `Backend health check failed at ${healthUrl}. Ensure npm run dev is running for this project. Details: ${message}`
    );
  }
};

const safeParse = (raw: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const main = async (): Promise<void> => {
  await assertBackendHealth();

  const driverWs = new WebSocket(`${backendWsBase}/ws/drivers`, wsOptions);
  const ambulanceWs = new WebSocket(`${backendWsBase}/ws/ambulances`, wsOptions);

  let driverProgress = 0.34;
  let ambulanceProgress = 0.05;
  let alertCount = 0;
  let markerCount = 0;
  let driverTimer: NodeJS.Timeout | null = null;
  let ambulanceTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    if (driverTimer) {
      clearInterval(driverTimer);
    }
    if (ambulanceTimer) {
      clearInterval(ambulanceTimer);
    }

    if (driverWs.readyState === WebSocket.OPEN || driverWs.readyState === WebSocket.CONNECTING) {
      driverWs.close(1000, "sim shutdown");
    }
    if (
      ambulanceWs.readyState === WebSocket.OPEN ||
      ambulanceWs.readyState === WebSocket.CONNECTING
    ) {
      ambulanceWs.close(1000, "sim shutdown");
    }

    await sleep(100);
    console.log(
      `[sim] finished (${reason}) markerEvents=${markerCount} alertEvents=${alertCount}`
    );
    process.exit(reason.includes("error") ? 1 : 0);
  };

  driverWs.on("open", () => {
    const driverPosition = interpolateOnRoute(driverProgress);
    driverWs.send(
      JSON.stringify({
        type: "driver.register_route",
        sessionId: "sim-driver-session",
        driverId: "sim-driver",
        platform: "android",
        appState: "foreground",
        currentPosition: {
          ...driverPosition,
          heading: 90,
          speedMps: 9.5,
          timestamp: Date.now()
        },
        route: {
          routeId: "sim-route",
          polyline: route
        }
      })
    );

    driverTimer = setInterval(() => {
      if (driverWs.readyState !== WebSocket.OPEN) {
        return;
      }

      driverProgress = Math.min(0.95, driverProgress + 0.004);
      const position = interpolateOnRoute(driverProgress);
      driverWs.send(
        JSON.stringify({
          type: "driver.progress",
          sessionId: "sim-driver-session",
          appState: "foreground",
          currentPosition: {
            ...position,
            heading: 90,
            speedMps: 9.5,
            timestamp: Date.now()
          }
        })
      );
    }, driverTickMs);
  });

  driverWs.on("message", (raw) => {
    const payload = safeParse(raw.toString());
    if (!payload) {
      console.warn("[sim] received non-JSON message on driver socket.");
      return;
    }

    if (payload.type === "error") {
      console.warn(`[sim] backend driver error: ${String(payload.message ?? "unknown")}`);
      return;
    }
    if (payload.type === "ack") {
      return;
    }
    if (payload.type === "ambulance.alert") {
      alertCount += 1;
      console.log(
        `[alert] ambulance=${payload.ambulanceId} severity=${payload.severity} distance=${payload.distanceMeters}m tti=${payload.timeToImpactSeconds}s`
      );
      return;
    }
    if (payload.type === "ambulance.marker") {
      markerCount += 1;
    }
  });

  ambulanceWs.on("open", () => {
    ambulanceTimer = setInterval(() => {
      if (ambulanceWs.readyState !== WebSocket.OPEN) {
        return;
      }

      ambulanceProgress = Math.min(0.9, ambulanceProgress + 0.008);
      const position = interpolateOnRoute(ambulanceProgress);
      ambulanceWs.send(
        JSON.stringify({
          type: "ambulance.location",
          ambulanceId: "sim-ambulance-1",
          position: {
            ...position,
            heading: 90,
            speedMps: 15,
            timestamp: Date.now()
          }
        })
      );
    }, ambulanceTickMs);
  });

  driverWs.on("error", (error) => {
    console.error(`[sim] driver socket error: ${error.message}`);
    void shutdown("driver socket error");
  });
  ambulanceWs.on("error", (error) => {
    console.error(`[sim] ambulance socket error: ${error.message}`);
    void shutdown("ambulance socket error");
  });

  driverWs.on("close", (code, reasonBuffer) => {
    if (!shuttingDown && code !== 1000) {
      const reason = reasonBuffer.toString() || "no reason";
      console.error(`[sim] driver socket closed unexpectedly code=${code} reason=${reason}`);
      void shutdown("driver socket closed");
    }
  });
  ambulanceWs.on("close", (code, reasonBuffer) => {
    if (!shuttingDown && code !== 1000) {
      const reason = reasonBuffer.toString() || "no reason";
      console.error(
        `[sim] ambulance socket closed unexpectedly code=${code} reason=${reason}`
      );
      void shutdown("ambulance socket closed");
    }
  });

  setTimeout(() => {
    void shutdown("duration elapsed");
  }, durationSeconds * 1000);

  process.on("SIGINT", () => {
    void shutdown("sigint");
  });
  process.on("SIGTERM", () => {
    void shutdown("sigterm");
  });

  console.log(
    `[sim] running for ${durationSeconds}s against ${backendWsBase}. driverTick=${driverTickMs}ms ambulanceTick=${ambulanceTickMs}ms`
  );
};

void main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`[sim] startup failed: ${message}`);
  process.exit(1);
});

