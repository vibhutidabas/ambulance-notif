import dotenv from "dotenv";

dotenv.config();

const numberFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : fallback;
  return Number.isFinite(parsed) ? parsed : fallback;
};

export interface AppConfig {
  port: number;
  redisUrl?: string;
  ambulanceTtlSeconds: number;
  driverStaleSeconds: number;
  gridCellMeters: number;
  defaultRouteBufferMeters: number;
  alertCooldownSeconds: number;
  fcmEnabled: boolean;
  googleMapsApiKey?: string;
  routesApiUrl: string;
  rerouteAlternativeCount: number;
}

export const config: AppConfig = {
  port: numberFromEnv("PORT", 8080),
  redisUrl: process.env.REDIS_URL,
  ambulanceTtlSeconds: numberFromEnv("AMBULANCE_TTL_SECONDS", 15),
  driverStaleSeconds: numberFromEnv("DRIVER_STALE_SECONDS", 120),
  gridCellMeters: numberFromEnv("GRID_CELL_METERS", 250),
  defaultRouteBufferMeters: numberFromEnv("DEFAULT_ROUTE_BUFFER_METERS", 80),
  alertCooldownSeconds: numberFromEnv("ALERT_COOLDOWN_SECONDS", 10),
  fcmEnabled: String(process.env.FCM_ENABLED).toLowerCase() === "true",
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
  routesApiUrl:
    process.env.ROUTES_API_URL ??
    "https://routes.googleapis.com/directions/v2:computeRoutes",
  rerouteAlternativeCount: numberFromEnv("REROUTE_ALTERNATIVE_COUNT", 3)
};
