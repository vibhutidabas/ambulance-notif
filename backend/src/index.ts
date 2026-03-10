import http from "http";

import { config } from "./config";
import { createHttpApp } from "./transports/httpServer";
import { attachWebSocketTransports } from "./transports/websocketServer";
import { AmbulanceRegistry } from "./services/ambulanceRegistry";
import { AlertEngine } from "./services/alertEngine";
import { createAmbulanceStateStore } from "./services/ambulanceStateStore";
import { DriverSessionRegistry } from "./services/driverSessionRegistry";
import {
  FirebasePushNotificationService,
  NoopPushNotificationService
} from "./services/pushNotificationService";
import { SocketHub } from "./services/socketHub";
import { SpatialMatcher } from "./services/spatialMatcher";
import { createRerouteService } from "./services/rerouteService";

const rerouteService = createRerouteService(
  config.googleMapsApiKey,
  config.routesApiUrl,
  config.rerouteAlternativeCount
);
const httpApp = createHttpApp({ rerouteService });
const server = http.createServer(httpApp);

const ambulanceRegistry = new AmbulanceRegistry(
  createAmbulanceStateStore(config.redisUrl),
  config.ambulanceTtlSeconds
);
const driverSessions = new DriverSessionRegistry(
  config.gridCellMeters,
  config.defaultRouteBufferMeters,
  config.driverStaleSeconds
);
const socketHub = new SocketHub();
const pushNotifications = config.fcmEnabled
  ? new FirebasePushNotificationService()
  : new NoopPushNotificationService();
const alertEngine = new AlertEngine(
  driverSessions,
  socketHub,
  pushNotifications,
  new SpatialMatcher(),
  config.alertCooldownSeconds
);

attachWebSocketTransports({
  server,
  ambulanceRegistry,
  driverSessions,
  alertEngine,
  socketHub
});

setInterval(() => {
  ambulanceRegistry.pruneExpired();
  driverSessions.pruneStale();
}, 5_000).unref();

server.listen(config.port, () => {
  console.log(`ambulance-alert-backend listening on :${config.port}`);
});
