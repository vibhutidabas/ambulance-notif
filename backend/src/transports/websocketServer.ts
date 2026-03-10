import http from "http";
import WebSocket, { WebSocketServer } from "ws";

import { AmbulanceRegistry } from "../services/ambulanceRegistry";
import { AlertEngine } from "../services/alertEngine";
import { DriverSessionRegistry } from "../services/driverSessionRegistry";
import { SocketHub } from "../services/socketHub";
import {
  AmbulanceIngress,
  DriverProgressUpdate,
  DriverRegistration
} from "../domain/types";

interface Dependencies {
  server: http.Server;
  ambulanceRegistry: AmbulanceRegistry;
  driverSessions: DriverSessionRegistry;
  alertEngine: AlertEngine;
  socketHub: SocketHub;
}

export const attachWebSocketTransports = ({
  server,
  ambulanceRegistry,
  driverSessions,
  alertEngine,
  socketHub
}: Dependencies): void => {
  const ambulanceWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false
  });
  const driverWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false
  });

  server.on("upgrade", (request, socket, head) => {
    const pathname = getPathname(request);
    if (pathname === "/ws/ambulances") {
      ambulanceWss.handleUpgrade(request, socket, head, (ws) => {
        ambulanceWss.emit("connection", ws, request);
      });
      return;
    }

    if (pathname === "/ws/drivers") {
      driverWss.handleUpgrade(request, socket, head, (ws) => {
        driverWss.emit("connection", ws, request);
      });
      return;
    }

    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });

  ambulanceWss.on("connection", (socket) => {
    socket.on("message", async (rawMessage) => {
      const payload = safeParse(rawMessage.toString());
      if (!isAmbulanceIngress(payload)) {
        sendError(socket, "Invalid ambulance payload.");
        return;
      }

      const ambulance = await ambulanceRegistry.upsert(payload);
      await alertEngine.handleAmbulanceUpdate(ambulance);
    });
  });

  driverWss.on("connection", (socket) => {
    let sessionId: string | null = null;

    socket.on("message", (rawMessage) => {
      const payload = safeParse(rawMessage.toString());

      if (isDriverRegistration(payload)) {
        sessionId = payload.sessionId;
        driverSessions.register(payload);
        socketHub.bindDriver(payload.sessionId, socket);
        sendAck(socket, "driver.registered");
        return;
      }

      if (isDriverProgressUpdate(payload)) {
        const session = driverSessions.updateProgress(payload);
        if (!session) {
          sendError(socket, "Driver session not found.");
          return;
        }

        sessionId = session.sessionId;
        socketHub.bindDriver(session.sessionId, socket);
        sendAck(socket, "driver.updated");
        return;
      }

      sendError(socket, "Invalid driver payload.");
    });

    socket.on("close", () => {
      if (!sessionId) {
        return;
      }

      driverSessions.markDisconnected(sessionId);
      socketHub.unbindDriver(sessionId, socket);
    });
  });
};

const safeParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const getPathname = (request: http.IncomingMessage): string => {
  const host = request.headers.host ?? "localhost";
  const url = request.url ?? "/";
  return new URL(url, `http://${host}`).pathname;
};

const sendAck = (socket: WebSocket, status: string): void => {
  socket.send(JSON.stringify({ type: "ack", status }));
};

const sendError = (socket: WebSocket, message: string): void => {
  socket.send(JSON.stringify({ type: "error", message }));
};

const isLatLng = (value: unknown): value is { lat: number; lng: number } => {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).lat === "number" &&
      typeof (value as Record<string, unknown>).lng === "number"
  );
};

const isPosition = (value: unknown): boolean => {
  return Boolean(
    isLatLng(value) &&
      typeof (value as Record<string, unknown>).timestamp === "number"
  );
};

const isAmbulanceIngress = (value: unknown): value is AmbulanceIngress => {
  const record = value as Record<string, unknown> | null;
  return Boolean(
    record &&
      record.type === "ambulance.location" &&
      typeof record.ambulanceId === "string" &&
      isPosition(record.position) &&
      (!record.pathHint ||
        (Array.isArray(record.pathHint) && record.pathHint.every(isLatLng)))
  );
};

const isDriverRegistration = (value: unknown): value is DriverRegistration => {
  const record = value as Record<string, unknown> | null;
  const route = record?.route as Record<string, unknown> | undefined;

  return Boolean(
    record &&
      record.type === "driver.register_route" &&
      typeof record.sessionId === "string" &&
      typeof record.driverId === "string" &&
      (record.platform === "android" || record.platform === "ios") &&
      (record.appState === "foreground" || record.appState === "background") &&
      isPosition(record.currentPosition) &&
      route &&
      typeof route.routeId === "string" &&
      Array.isArray(route.polyline) &&
      route.polyline.length >= 2 &&
      route.polyline.every(isLatLng)
  );
};

const isDriverProgressUpdate = (value: unknown): value is DriverProgressUpdate => {
  const record = value as Record<string, unknown> | null;
  return Boolean(
    record &&
      record.type === "driver.progress" &&
      typeof record.sessionId === "string" &&
      isPosition(record.currentPosition) &&
      (!record.appState ||
        record.appState === "foreground" ||
        record.appState === "background")
  );
};
