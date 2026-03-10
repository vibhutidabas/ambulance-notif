import { LatLng, Position, RouteProjection } from "./types";

const EARTH_RADIUS_METERS = 6_371_000;

const toRadians = (value: number): number => value * (Math.PI / 180);
const toDegrees = (value: number): number => value * (180 / Math.PI);

export const haversineDistanceMeters = (a: LatLng, b: LatLng): number => {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
};

export const bearingDegrees = (a: LatLng, b: LatLng): number => {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLng = toRadians(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
};

export const headingDeltaDegrees = (
  aHeading: number | undefined,
  bHeading: number | undefined
): number => {
  if (aHeading === undefined || bHeading === undefined) {
    return 180;
  }

  const delta = Math.abs(aHeading - bHeading) % 360;
  return delta > 180 ? 360 - delta : delta;
};

export const cumulativeDistances = (polyline: LatLng[]): number[] => {
  if (polyline.length === 0) {
    return [];
  }

  const distances = [0];
  for (let index = 1; index < polyline.length; index += 1) {
    distances[index] =
      distances[index - 1] +
      haversineDistanceMeters(polyline[index - 1], polyline[index]);
  }

  return distances;
};

const toLocalMeters = (origin: LatLng, point: LatLng): { x: number; y: number } => {
  const latScale = EARTH_RADIUS_METERS * toRadians(1);
  const lngScale = latScale * Math.cos(toRadians(origin.lat));

  return {
    x: (point.lng - origin.lng) * lngScale,
    y: (point.lat - origin.lat) * latScale
  };
};

const fromLocalMeters = (
  origin: LatLng,
  point: { x: number; y: number }
): LatLng => {
  const latScale = EARTH_RADIUS_METERS * toRadians(1);
  const lngScale = latScale * Math.cos(toRadians(origin.lat));

  return {
    lat: origin.lat + point.y / latScale,
    lng: origin.lng + point.x / lngScale
  };
};

export interface SegmentIntersection {
  point: LatLng;
  firstSegmentFraction: number;
  secondSegmentFraction: number;
}

const cross2d = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  a.x * b.y - a.y * b.x;

export const intersectSegments = (
  firstStart: LatLng,
  firstEnd: LatLng,
  secondStart: LatLng,
  secondEnd: LatLng
): SegmentIntersection | null => {
  const p = { x: 0, y: 0 };
  const r = toLocalMeters(firstStart, firstEnd);
  const q = toLocalMeters(firstStart, secondStart);
  const secondEndLocal = toLocalMeters(firstStart, secondEnd);
  const s = {
    x: secondEndLocal.x - q.x,
    y: secondEndLocal.y - q.y
  };
  const denominator = cross2d(r, s);

  if (Math.abs(denominator) < 1e-8) {
    return null;
  }

  const qMinusP = {
    x: q.x - p.x,
    y: q.y - p.y
  };
  const t = cross2d(qMinusP, s) / denominator;
  const u = cross2d(qMinusP, r) / denominator;

  if (t < 0 || t > 1 || u < 0 || u > 1) {
    return null;
  }

  const intersectionLocal = {
    x: p.x + t * r.x,
    y: p.y + t * r.y
  };

  return {
    point: fromLocalMeters(firstStart, intersectionLocal),
    firstSegmentFraction: t,
    secondSegmentFraction: u
  };
};

export const projectPointOntoPolyline = (
  point: LatLng,
  polyline: LatLng[],
  distances = cumulativeDistances(polyline)
): RouteProjection | null => {
  if (polyline.length < 2) {
    return null;
  }

  let bestProjection: RouteProjection | null = null;

  for (let index = 0; index < polyline.length - 1; index += 1) {
    const start = polyline[index];
    const end = polyline[index + 1];
    const localEnd = toLocalMeters(start, end);
    const localPoint = toLocalMeters(start, point);
    const segmentLengthSquared =
      localEnd.x * localEnd.x + localEnd.y * localEnd.y;

    const t = segmentLengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            (localPoint.x * localEnd.x + localPoint.y * localEnd.y) /
              segmentLengthSquared
          )
        );

    const nearestLocal = {
      x: localEnd.x * t,
      y: localEnd.y * t
    };
    const nearestPoint = fromLocalMeters(start, nearestLocal);
    const distanceMeters = haversineDistanceMeters(point, nearestPoint);
    const segmentLength = haversineDistanceMeters(start, end);
    const progressMeters = distances[index] + segmentLength * t;
    const candidate: RouteProjection = {
      nearestPoint,
      segmentIndex: index,
      segmentBearing: bearingDegrees(start, end),
      progressMeters,
      distanceMeters
    };

    if (!bestProjection || candidate.distanceMeters < bestProjection.distanceMeters) {
      bestProjection = candidate;
    }
  }

  return bestProjection;
};

export const interpolatePoint = (
  start: LatLng,
  end: LatLng,
  fraction: number
): LatLng => {
  const clamped = Math.max(0, Math.min(1, fraction));
  return {
    lat: start.lat + (end.lat - start.lat) * clamped,
    lng: start.lng + (end.lng - start.lng) * clamped
  };
};

export const densifyPolyline = (
  polyline: LatLng[],
  stepMeters = 25
): LatLng[] => {
  if (polyline.length < 2) {
    return [...polyline];
  }

  const densified: LatLng[] = [polyline[0]];

  for (let index = 0; index < polyline.length - 1; index += 1) {
    const start = polyline[index];
    const end = polyline[index + 1];
    const segmentLength = haversineDistanceMeters(start, end);
    const steps = Math.max(1, Math.ceil(segmentLength / stepMeters));

    for (let step = 1; step <= steps; step += 1) {
      densified.push(interpolatePoint(start, end, step / steps));
    }
  }

  return densified;
};

export const advancePoint = (
  point: LatLng,
  headingDegrees: number,
  distanceMeters: number
): LatLng => {
  const heading = toRadians(headingDegrees);
  const lat1 = toRadians(point.lat);
  const lng1 = toRadians(point.lng);
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(heading)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(heading) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    lat: toDegrees(lat2),
    lng: toDegrees(lng2)
  };
};

export const predictTrajectory = (
  position: Position,
  pathHint: LatLng[] | undefined,
  horizonSeconds: number,
  stepSeconds: number
): LatLng[] => {
  if (pathHint && pathHint.length > 0) {
    return [position, ...pathHint];
  }

  const heading = position.heading ?? 0;
  const speed = Math.max(position.speedMps ?? 13.9, 5);
  const trajectory: LatLng[] = [position];

  for (
    let elapsedSeconds = stepSeconds;
    elapsedSeconds <= horizonSeconds;
    elapsedSeconds += stepSeconds
  ) {
    trajectory.push(advancePoint(position, heading, speed * elapsedSeconds));
  }

  return trajectory;
};

export const cellKeysAroundPoint = (
  point: LatLng,
  radiusMeters: number,
  cellSizeMeters: number
): string[] => {
  const latMeters = 111_320;
  const lngMeters = 111_320 * Math.cos(toRadians(point.lat));
  const centerX = Math.floor((point.lng * lngMeters) / cellSizeMeters);
  const centerY = Math.floor((point.lat * latMeters) / cellSizeMeters);
  const radiusCells = Math.max(1, Math.ceil(radiusMeters / cellSizeMeters));
  const keys: string[] = [];

  for (let x = centerX - radiusCells; x <= centerX + radiusCells; x += 1) {
    for (let y = centerY - radiusCells; y <= centerY + radiusCells; y += 1) {
      keys.push(`${x}:${y}`);
    }
  }

  return keys;
};

export const routeCellKeys = (
  polyline: LatLng[],
  bufferMeters: number,
  cellSizeMeters: number
): string[] => {
  const keys = new Set<string>();

  for (const point of densifyPolyline(polyline, Math.max(20, bufferMeters / 2))) {
    for (const cellKey of cellKeysAroundPoint(point, bufferMeters, cellSizeMeters)) {
      keys.add(cellKey);
    }
  }

  return [...keys];
};
