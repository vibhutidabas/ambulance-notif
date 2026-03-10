export type Platform = "android" | "ios";
export type AppState = "foreground" | "background";
export type MatchType = "rear_approach" | "intersection_ahead";
export type AlertSeverity = "info" | "warning" | "critical";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Position extends LatLng {
  heading?: number;
  speedMps?: number;
  timestamp: number;
}

export interface RoutePayload {
  routeId: string;
  polyline: LatLng[];
  etaSeconds?: number;
}

export interface DriverRegistration {
  sessionId: string;
  driverId: string;
  platform: Platform;
  appState: AppState;
  pushToken?: string;
  currentPosition: Position;
  route: RoutePayload;
}

export interface DriverProgressUpdate {
  sessionId: string;
  appState?: AppState;
  pushToken?: string;
  currentPosition: Position;
}

export interface DriverSessionState extends DriverRegistration {
  connected: boolean;
  routeDistances: number[];
  routeCellKeys: string[];
  corridorMeters: number;
  updatedAt: number;
}

export interface AmbulanceIngress {
  ambulanceId: string;
  position: Position;
  pathHint?: LatLng[];
}

export interface AmbulanceState extends AmbulanceIngress {
  expiresAt: number;
  updatedAt: number;
}

export interface RouteProjection {
  nearestPoint: LatLng;
  segmentIndex: number;
  segmentBearing: number;
  progressMeters: number;
  distanceMeters: number;
}

export interface MatchResult {
  matchType: MatchType;
  severity: AlertSeverity;
  message: string;
  distanceMeters: number;
  timeToImpactSeconds: number;
  routeProgressMeters: number;
  predictedIntersection?: PredictedIntersection;
  rerouteSuggestion?: RerouteSuggestion;
}

export interface PredictedIntersection {
  point: LatLng;
  driverProgressMeters: number;
  ambulanceTimeToIntersectionSeconds: number;
}

export interface RerouteSuggestion {
  reason: "ambulance_intersection";
  avoidPoint: LatLng;
  avoidRadiusMeters: number;
  recommendedWithinSeconds: number;
}

export interface AmbulanceMarkerEvent {
  type: "ambulance.marker";
  sessionId: string;
  ambulanceId: string;
  status: "tracking" | "shared_corridor" | "projected_conflict";
  position: Position;
  distanceMeters?: number;
  routeProgressMeters?: number;
}

export interface AmbulanceAlertEvent {
  type: "ambulance.alert";
  sessionId: string;
  ambulanceId: string;
  severity: AlertSeverity;
  matchType: MatchType;
  message: string;
  distanceMeters: number;
  timeToImpactSeconds: number;
  position: Position;
  predictedIntersection?: PredictedIntersection;
  rerouteSuggestion?: RerouteSuggestion;
}

export type DriverOutboundEvent = AmbulanceMarkerEvent | AmbulanceAlertEvent;
