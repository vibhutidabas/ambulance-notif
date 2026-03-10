import {
  AmbulanceAlertEvent,
  AmbulanceMarkerEvent,
  AmbulanceState,
  DriverSessionState
} from "../domain/types";
import { DriverSessionRegistry } from "./driverSessionRegistry";
import { PushNotificationService } from "./pushNotificationService";
import { SocketHub } from "./socketHub";
import { SpatialMatcher } from "./spatialMatcher";

export class AlertEngine {
  private readonly lastAlertAt = new Map<string, number>();

  constructor(
    private readonly driverSessions: DriverSessionRegistry,
    private readonly socketHub: SocketHub,
    private readonly pushNotifications: PushNotificationService,
    private readonly matcher: SpatialMatcher,
    private readonly cooldownSeconds: number
  ) {}

  async handleAmbulanceUpdate(ambulance: AmbulanceState): Promise<void> {
    const trajectory = this.matcher.buildTrajectory(ambulance);
    const candidateSessions = this.driverSessions.findByTrajectory(
      trajectory,
      150
    );

    for (const session of candidateSessions) {
      await this.deliverForSession(session, ambulance);
    }
  }

  private async deliverForSession(
    session: DriverSessionState,
    ambulance: AmbulanceState
  ): Promise<void> {
    const match = this.matcher.evaluate(session, ambulance);

    if (match) {
      const markerEvent: AmbulanceMarkerEvent = {
        type: "ambulance.marker",
        sessionId: session.sessionId,
        ambulanceId: ambulance.ambulanceId,
        status:
          match.matchType === "rear_approach"
            ? "shared_corridor"
            : "projected_conflict",
        position: ambulance.position,
        distanceMeters: match.distanceMeters,
        routeProgressMeters: Math.round(match.routeProgressMeters)
      };
      this.socketHub.sendToDriver(session.sessionId, markerEvent);

      if (!this.isCoolingDown(session.sessionId, ambulance.ambulanceId)) {
        const alertEvent: AmbulanceAlertEvent = {
          type: "ambulance.alert",
          sessionId: session.sessionId,
          ambulanceId: ambulance.ambulanceId,
          severity: match.severity,
          matchType: match.matchType,
          message: match.message,
          distanceMeters: match.distanceMeters,
          timeToImpactSeconds: match.timeToImpactSeconds,
          position: ambulance.position,
          predictedIntersection: match.predictedIntersection,
          rerouteSuggestion: match.rerouteSuggestion
        };

        const delivered = this.socketHub.sendToDriver(session.sessionId, alertEvent);
        this.markSent(session.sessionId, ambulance.ambulanceId);

        if (!delivered || session.appState === "background") {
          await this.pushNotifications.sendAlert(session, alertEvent);
        }
      }

      return;
    }

    const markerOnlyEvent: AmbulanceMarkerEvent = {
      type: "ambulance.marker",
      sessionId: session.sessionId,
      ambulanceId: ambulance.ambulanceId,
      status: "tracking",
      position: ambulance.position
    };
    this.socketHub.sendToDriver(session.sessionId, markerOnlyEvent);
  }

  private isCoolingDown(sessionId: string, ambulanceId: string): boolean {
    const key = `${sessionId}:${ambulanceId}`;
    const previous = this.lastAlertAt.get(key) ?? 0;
    return Date.now() - previous < this.cooldownSeconds * 1000;
  }

  private markSent(sessionId: string, ambulanceId: string): void {
    this.lastAlertAt.set(`${sessionId}:${ambulanceId}`, Date.now());
  }
}
