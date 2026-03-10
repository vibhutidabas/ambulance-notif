import { densifyPolyline, haversineDistanceMeters } from "../domain/spatial";
import { LatLng } from "../domain/types";

export interface RerouteOptionsRequest {
  origin: LatLng;
  destination: LatLng;
  avoidPoint: LatLng;
  avoidRadiusMeters: number;
  alternativeCount?: number;
}

export interface RerouteOption {
  id: string;
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline: string;
  minDistanceToAvoidMeters: number;
  intersectsAvoidZone: boolean;
  recommended: boolean;
  routeLabels: string[];
}

export interface RerouteOptionsResponse {
  routes: RerouteOption[];
  selectedRouteId?: string;
}

export interface RerouteService {
  getAlternatives(request: RerouteOptionsRequest): Promise<RerouteOptionsResponse>;
}

export class RerouteServiceError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "RerouteServiceError";
  }
}

export class DisabledRerouteService implements RerouteService {
  async getAlternatives(): Promise<RerouteOptionsResponse> {
    throw new RerouteServiceError(
      503,
      "Reroute service disabled. Set GOOGLE_MAPS_API_KEY to enable Routes API."
    );
  }
}

export class GoogleRoutesRerouteService implements RerouteService {
  constructor(
    private readonly apiKey: string,
    private readonly routesApiUrl: string,
    private readonly defaultAlternativeCount: number
  ) {}

  async getAlternatives(
    request: RerouteOptionsRequest
  ): Promise<RerouteOptionsResponse> {
    const alternativeCount = normalizeAlternativeCount(
      request.alternativeCount ?? this.defaultAlternativeCount
    );
    const body = {
      origin: toWaypoint(request.origin),
      destination: toWaypoint(request.destination),
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      computeAlternativeRoutes: true,
      languageCode: "en-US",
      units: "METRIC"
    };

    const response = await fetch(this.routesApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask":
          "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.routeLabels"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message = extractRoutesErrorMessage(payload);
      throw new RerouteServiceError(
        response.status,
        `Routes API request failed: ${message}`
      );
    }

    const rawRoutes = Array.isArray((payload as { routes?: unknown })?.routes)
      ? ((payload as { routes: unknown[] }).routes)
      : [];
    if (rawRoutes.length === 0) {
      throw new RerouteServiceError(
        502,
        "Routes API returned no alternatives."
      );
    }

    const mapped = rawRoutes
      .slice(0, alternativeCount)
      .map((route, index) =>
        mapRouteOption(route, index, request.avoidPoint, request.avoidRadiusMeters)
      );
    const ranked = rankAlternatives(mapped);
    const selected = ranked.find((route) => route.recommended) ?? ranked[0];

    return {
      routes: ranked,
      selectedRouteId: selected?.id
    };
  }
}

const toWaypoint = (point: LatLng): { location: { latLng: { latitude: number; longitude: number } } } => ({
  location: {
    latLng: {
      latitude: point.lat,
      longitude: point.lng
    }
  }
});

const normalizeAlternativeCount = (value: number): number =>
  Math.max(1, Math.min(5, Math.round(value)));

const extractRoutesErrorMessage = (payload: unknown): string => {
  const message =
    typeof payload === "object" &&
    payload &&
    typeof (payload as { error?: { message?: unknown } }).error?.message ===
      "string"
      ? (payload as { error: { message: string } }).error.message
      : "unknown error";

  return message;
};

const parseDurationSeconds = (value: unknown): number => {
  if (typeof value !== "string") {
    return 0;
  }

  const normalized = value.endsWith("s") ? value.slice(0, -1) : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
};

const minDistanceToPointMeters = (points: LatLng[], avoidPoint: LatLng): number => {
  if (points.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  let minDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    minDistance = Math.min(minDistance, haversineDistanceMeters(point, avoidPoint));
  }

  return minDistance;
};

const mapRouteOption = (
  route: unknown,
  index: number,
  avoidPoint: LatLng,
  avoidRadiusMeters: number
): RerouteOption => {
  const routeRecord = route as {
    distanceMeters?: unknown;
    duration?: unknown;
    polyline?: { encodedPolyline?: unknown };
    routeLabels?: unknown;
  };
  const encodedPolyline =
    typeof routeRecord.polyline?.encodedPolyline === "string"
      ? routeRecord.polyline.encodedPolyline
      : "";
  const decodedPolyline = densifyPolyline(
    decodeEncodedPolyline(encodedPolyline),
    20
  );
  const minDistance = minDistanceToPointMeters(decodedPolyline, avoidPoint);
  const intersectsAvoidZone = minDistance <= avoidRadiusMeters;
  const distanceMeters =
    typeof routeRecord.distanceMeters === "number"
      ? Math.max(0, Math.round(routeRecord.distanceMeters))
      : 0;
  const durationSeconds = parseDurationSeconds(routeRecord.duration);
  const labels = Array.isArray(routeRecord.routeLabels)
    ? routeRecord.routeLabels.filter((label): label is string => typeof label === "string")
    : [];

  return {
    id: `route-${index + 1}`,
    distanceMeters,
    durationSeconds,
    encodedPolyline,
    minDistanceToAvoidMeters: Number.isFinite(minDistance)
      ? Math.round(minDistance)
      : Number.MAX_SAFE_INTEGER,
    intersectsAvoidZone,
    recommended: false,
    routeLabels: labels
  };
};

const rankAlternatives = (routes: RerouteOption[]): RerouteOption[] => {
  const sorted = [...routes].sort((left, right) => {
    if (left.intersectsAvoidZone !== right.intersectsAvoidZone) {
      return left.intersectsAvoidZone ? 1 : -1;
    }

    if (!left.intersectsAvoidZone && !right.intersectsAvoidZone) {
      if (left.durationSeconds !== right.durationSeconds) {
        return left.durationSeconds - right.durationSeconds;
      }
      return left.distanceMeters - right.distanceMeters;
    }

    if (left.minDistanceToAvoidMeters !== right.minDistanceToAvoidMeters) {
      return right.minDistanceToAvoidMeters - left.minDistanceToAvoidMeters;
    }

    return left.durationSeconds - right.durationSeconds;
  });

  if (sorted.length > 0) {
    sorted[0] = {
      ...sorted[0],
      recommended: true
    };
  }

  return sorted;
};

export const decodeEncodedPolyline = (encoded: string): LatLng[] => {
  if (!encoded) {
    return [];
  }

  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;

    do {
      if (index >= encoded.length) {
        return points;
      }
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += deltaLat;

    result = 0;
    shift = 0;

    do {
      if (index >= encoded.length) {
        return points;
      }
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += deltaLng;

    points.push({
      lat: lat / 1e5,
      lng: lng / 1e5
    });
  }

  return points;
};

export const createRerouteService = (
  apiKey: string | undefined,
  routesApiUrl: string,
  defaultAlternativeCount: number
): RerouteService => {
  if (!apiKey) {
    return new DisabledRerouteService();
  }

  return new GoogleRoutesRerouteService(
    apiKey,
    routesApiUrl,
    defaultAlternativeCount
  );
};
