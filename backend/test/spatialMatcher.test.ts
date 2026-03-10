import assert from "node:assert/strict";
import test from "node:test";

import { cumulativeDistances } from "../src/domain/spatial";
import { SpatialMatcher } from "../src/services/spatialMatcher";
import { AmbulanceState, DriverSessionState } from "../src/domain/types";

const route = [
  { lat: 12.9716, lng: 77.5946 },
  { lat: 12.97165, lng: 77.5982 },
  { lat: 12.9717, lng: 77.6018 }
];

const buildDriverSession = (overrides?: Partial<DriverSessionState>): DriverSessionState => ({
  sessionId: "test-session",
  driverId: "driver-1",
  platform: "android",
  appState: "foreground",
  pushToken: "token",
  connected: true,
  currentPosition: {
    lat: 12.97163,
    lng: 77.5988,
    heading: 90,
    speedMps: 10,
    timestamp: Date.now()
  },
  route: {
    routeId: "route-1",
    polyline: route
  },
  corridorMeters: 90,
  routeDistances: cumulativeDistances(route),
  routeCellKeys: [],
  updatedAt: Date.now(),
  ...overrides
});

const buildAmbulanceState = (overrides?: Partial<AmbulanceState>): AmbulanceState => ({
  ambulanceId: "amb-1",
  position: {
    lat: 12.97162,
    lng: 77.5976,
    heading: 90,
    speedMps: 14,
    timestamp: Date.now()
  },
  updatedAt: Date.now(),
  expiresAt: Date.now() + 15_000,
  ...overrides
});

test("detects rear approach on shared corridor", () => {
  const matcher = new SpatialMatcher();
  const driver = buildDriverSession();
  const ambulance = buildAmbulanceState();

  const match = matcher.evaluate(driver, ambulance);
  assert.ok(match, "Expected a rear approach match.");
  assert.equal(match?.matchType, "rear_approach");
  assert.ok(match!.distanceMeters > 0);
  assert.equal(match?.predictedIntersection, undefined);
  assert.equal(match?.rerouteSuggestion, undefined);
});

test("detects intersection ahead from path hint", () => {
  const matcher = new SpatialMatcher();
  const driver = buildDriverSession({
    currentPosition: {
      lat: 12.97162,
      lng: 77.5962,
      heading: 90,
      speedMps: 15,
      timestamp: Date.now()
    }
  });
  const ambulance = buildAmbulanceState({
    position: {
      lat: 12.9722,
      lng: 77.5992,
      heading: 180,
      speedMps: 11,
      timestamp: Date.now()
    },
    pathHint: [
      { lat: 12.9712, lng: 77.5992 },
      { lat: 12.9708, lng: 77.5992 }
    ]
  });

  const match = matcher.evaluate(driver, ambulance);
  assert.ok(match, "Expected an intersection-ahead match.");
  assert.equal(match?.matchType, "intersection_ahead");
  assert.ok(match?.predictedIntersection);
  assert.ok(match?.rerouteSuggestion);
});

test("does not match when ambulance is far from route", () => {
  const matcher = new SpatialMatcher();
  const driver = buildDriverSession();
  const ambulance = buildAmbulanceState({
    position: {
      lat: 12.9805,
      lng: 77.625,
      heading: 310,
      speedMps: 20,
      timestamp: Date.now()
    },
    pathHint: []
  });

  const match = matcher.evaluate(driver, ambulance);
  assert.equal(match, null);
});
