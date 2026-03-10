import {
  cumulativeDistances,
  haversineDistanceMeters,
  headingDeltaDegrees,
  intersectSegments,
  predictTrajectory,
  projectPointOntoPolyline
} from "../domain/spatial";
import { AmbulanceState, DriverSessionState, MatchResult } from "../domain/types";

const REAR_APPROACH_MAX_HEADING_DELTA = 45;
const MIN_INTERSECTION_AHEAD_METERS = 40;

export class SpatialMatcher {
  buildTrajectory(ambulance: AmbulanceState): { lat: number; lng: number }[] {
    return predictTrajectory(ambulance.position, ambulance.pathHint, 45, 5);
  }

  evaluate(
    driverSession: DriverSessionState,
    ambulance: AmbulanceState
  ): MatchResult | null {
    const driverProjection = projectPointOntoPolyline(
      driverSession.currentPosition,
      driverSession.route.polyline,
      driverSession.routeDistances
    );
    const ambulanceProjection = projectPointOntoPolyline(
      ambulance.position,
      driverSession.route.polyline,
      driverSession.routeDistances
    );

    if (!driverProjection || !ambulanceProjection) {
      return null;
    }

    const rearApproach = this.evaluateRearApproach(
      driverSession,
      ambulance,
      driverProjection.progressMeters,
      ambulanceProjection.progressMeters,
      ambulanceProjection.distanceMeters,
      ambulanceProjection.segmentBearing
    );

    if (rearApproach) {
      return rearApproach;
    }

    return this.evaluatePredictedIntersection(
      driverSession,
      ambulance,
      driverProjection.progressMeters
    );
  }

  private evaluateRearApproach(
    driverSession: DriverSessionState,
    ambulance: AmbulanceState,
    driverProgressMeters: number,
    ambulanceProgressMeters: number,
    distanceToRouteMeters: number,
    segmentBearing: number
  ): MatchResult | null {
    const distanceGap = driverProgressMeters - ambulanceProgressMeters;
    const headingDelta = headingDeltaDegrees(
      ambulance.position.heading,
      segmentBearing
    );
    const closingWindowMeters = Math.max(
      180,
      (ambulance.position.speedMps ?? 13.9) * 25
    );

    if (
      distanceToRouteMeters > driverSession.corridorMeters ||
      headingDelta > REAR_APPROACH_MAX_HEADING_DELTA ||
      distanceGap <= 0 ||
      distanceGap > closingWindowMeters
    ) {
      return null;
    }

    const timeToImpactSeconds = Math.max(
      3,
      Math.round(distanceGap / Math.max(ambulance.position.speedMps ?? 10, 5))
    );

    return {
      matchType: "rear_approach",
      severity: severityFrom(distanceGap, timeToImpactSeconds),
      message: "Ambulance approaching on your route. Yield when safe.",
      distanceMeters: Math.round(distanceGap),
      timeToImpactSeconds,
      routeProgressMeters: ambulanceProgressMeters
    };
  }

  private evaluatePredictedIntersection(
    driverSession: DriverSessionState,
    ambulance: AmbulanceState,
    driverProgressMeters: number
  ): MatchResult | null {
    const trajectory = predictTrajectory(
      ambulance.position,
      ambulance.pathHint,
      45,
      5
    );
    if (trajectory.length < 2 || driverSession.route.polyline.length < 2) {
      return null;
    }

    const trajectoryDistances = cumulativeDistances(trajectory);
    const maxAheadMeters = Math.max(
      250,
      (driverSession.currentPosition.speedMps ?? 12) * 35
    );
    const ambulanceSpeedMps = Math.max(ambulance.position.speedMps ?? 10, 5);

    let bestMatch: MatchResult | null = null;

    for (let trajectoryIndex = 0; trajectoryIndex < trajectory.length - 1; trajectoryIndex += 1) {
      const trajectoryStart = trajectory[trajectoryIndex];
      const trajectoryEnd = trajectory[trajectoryIndex + 1];
      const trajectorySegmentLength = haversineDistanceMeters(
        trajectoryStart,
        trajectoryEnd
      );

      for (
        let routeSegmentIndex = 0;
        routeSegmentIndex < driverSession.route.polyline.length - 1;
        routeSegmentIndex += 1
      ) {
        const routeStart = driverSession.route.polyline[routeSegmentIndex];
        const routeEnd = driverSession.route.polyline[routeSegmentIndex + 1];
        const intersection = intersectSegments(
          trajectoryStart,
          trajectoryEnd,
          routeStart,
          routeEnd
        );
        if (!intersection) {
          continue;
        }

        const routeSegmentLength = haversineDistanceMeters(routeStart, routeEnd);
        const routeProgressAtIntersection =
          driverSession.routeDistances[routeSegmentIndex] +
          routeSegmentLength * intersection.secondSegmentFraction;
        const aheadDistanceMeters =
          routeProgressAtIntersection - driverProgressMeters;

        if (
          aheadDistanceMeters < MIN_INTERSECTION_AHEAD_METERS ||
          aheadDistanceMeters > maxAheadMeters
        ) {
          continue;
        }

        const ambulanceDistanceToIntersection =
          trajectoryDistances[trajectoryIndex] +
          trajectorySegmentLength * intersection.firstSegmentFraction;
        const timeToIntersectionSeconds = Math.max(
          1,
          Math.round(ambulanceDistanceToIntersection / ambulanceSpeedMps)
        );

        const candidate: MatchResult = {
          matchType: "intersection_ahead",
          severity: severityFrom(aheadDistanceMeters, timeToIntersectionSeconds),
          message:
            "Ambulance predicted to intersect your route ahead. Follow alternate route guidance.",
          distanceMeters: Math.round(aheadDistanceMeters),
          timeToImpactSeconds: timeToIntersectionSeconds,
          routeProgressMeters: routeProgressAtIntersection,
          predictedIntersection: {
            point: intersection.point,
            driverProgressMeters: routeProgressAtIntersection,
            ambulanceTimeToIntersectionSeconds: timeToIntersectionSeconds
          },
          rerouteSuggestion: {
            reason: "ambulance_intersection",
            avoidPoint: intersection.point,
            avoidRadiusMeters: rerouteAvoidRadius(driverSession.corridorMeters),
            recommendedWithinSeconds: Math.max(30, timeToIntersectionSeconds * 2)
          }
        };

        if (
          !bestMatch ||
          candidate.timeToImpactSeconds < bestMatch.timeToImpactSeconds
        ) {
          bestMatch = candidate;
        }
      }
    }

    return bestMatch;
  }
}

const rerouteAvoidRadius = (corridorMeters: number): number =>
  Math.max(80, Math.min(250, Math.round(corridorMeters * 2)));

const severityFrom = (
  distanceMeters: number,
  timeToImpactSeconds: number
): "info" | "warning" | "critical" => {
  if (timeToImpactSeconds <= 10 || distanceMeters <= 100) {
    return "critical";
  }

  if (timeToImpactSeconds <= 25 || distanceMeters <= 250) {
    return "warning";
  }

  return "info";
};

