import { RouteSpatialIndex } from "../domain/geoIndex";
import { cumulativeDistances, routeCellKeys } from "../domain/spatial";
import {
  DriverProgressUpdate,
  DriverRegistration,
  DriverSessionState,
  LatLng
} from "../domain/types";

export class DriverSessionRegistry {
  private readonly sessions = new Map<string, DriverSessionState>();
  private readonly spatialIndex: RouteSpatialIndex;

  constructor(
    private readonly cellSizeMeters: number,
    private readonly defaultRouteBufferMeters: number,
    private readonly staleAfterSeconds: number
  ) {
    this.spatialIndex = new RouteSpatialIndex(cellSizeMeters);
  }

  register(payload: DriverRegistration): DriverSessionState {
    const session: DriverSessionState = {
      ...payload,
      connected: true,
      corridorMeters: this.defaultRouteBufferMeters,
      routeDistances: cumulativeDistances(payload.route.polyline),
      routeCellKeys: routeCellKeys(
        payload.route.polyline,
        this.defaultRouteBufferMeters,
        this.cellSizeMeters
      ),
      updatedAt: Date.now()
    };

    this.sessions.set(payload.sessionId, session);
    this.spatialIndex.upsert(payload.sessionId, session.routeCellKeys);
    return session;
  }

  updateProgress(payload: DriverProgressUpdate): DriverSessionState | null {
    const existing = this.sessions.get(payload.sessionId);
    if (!existing) {
      return null;
    }

    const nextSession: DriverSessionState = {
      ...existing,
      appState: payload.appState ?? existing.appState,
      pushToken: payload.pushToken ?? existing.pushToken,
      currentPosition: payload.currentPosition,
      updatedAt: Date.now()
    };

    this.sessions.set(payload.sessionId, nextSession);
    return nextSession;
  }

  markDisconnected(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      return;
    }

    this.sessions.set(sessionId, {
      ...existing,
      connected: false,
      updatedAt: Date.now()
    });
  }

  findByTrajectory(points: LatLng[], radiusMeters: number): DriverSessionState[] {
    const sessionIds = this.spatialIndex.query(points, radiusMeters);
    return sessionIds
      .map((sessionId) => this.sessions.get(sessionId))
      .filter((session): session is DriverSessionState => Boolean(session))
      .filter((session) => this.isFresh(session));
  }

  pruneStale(now = Date.now()): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (!this.isFresh(session, now)) {
        this.spatialIndex.remove(sessionId);
        this.sessions.delete(sessionId);
      }
    }
  }

  private isFresh(session: DriverSessionState, now = Date.now()): boolean {
    return now - session.updatedAt <= this.staleAfterSeconds * 1000;
  }
}

