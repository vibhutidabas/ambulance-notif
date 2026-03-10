import admin from "firebase-admin";

import { AmbulanceAlertEvent, DriverSessionState } from "../domain/types";

export interface PushNotificationService {
  sendAlert(session: DriverSessionState, event: AmbulanceAlertEvent): Promise<void>;
}

export class NoopPushNotificationService implements PushNotificationService {
  async sendAlert(): Promise<void> {
    return Promise.resolve();
  }
}

export class FirebasePushNotificationService implements PushNotificationService {
  constructor() {
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault()
      });
    }
  }

  async sendAlert(
    session: DriverSessionState,
    event: AmbulanceAlertEvent
  ): Promise<void> {
    if (!session.pushToken) {
      return;
    }

    await admin.messaging().send({
      token: session.pushToken,
      notification: {
        title: "Ambulance nearby",
        body: event.message
      },
      data: {
        type: event.type,
        ambulanceId: event.ambulanceId,
        severity: event.severity,
        matchType: event.matchType,
        distanceMeters: String(event.distanceMeters),
        timeToImpactSeconds: String(event.timeToImpactSeconds),
        rerouteReason: event.rerouteSuggestion?.reason ?? "",
        avoidLat: String(event.rerouteSuggestion?.avoidPoint.lat ?? ""),
        avoidLng: String(event.rerouteSuggestion?.avoidPoint.lng ?? ""),
        avoidRadiusMeters: String(event.rerouteSuggestion?.avoidRadiusMeters ?? "")
      },
      android: {
        priority: "high"
      },
      apns: {
        headers: {
          "apns-priority": "10"
        }
      }
    });
  }
}
