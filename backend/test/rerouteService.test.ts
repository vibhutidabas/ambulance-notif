import assert from "node:assert/strict";
import test from "node:test";

import {
  DisabledRerouteService,
  GoogleRoutesRerouteService,
  RerouteServiceError,
  decodeEncodedPolyline
} from "../src/services/rerouteService";

const encodePolyline = (points: Array<{ lat: number; lng: number }>): string => {
  let lastLat = 0;
  let lastLng = 0;
  let output = "";

  for (const point of points) {
    const lat = Math.round(point.lat * 1e5);
    const lng = Math.round(point.lng * 1e5);
    output += encodeSigned(lat - lastLat);
    output += encodeSigned(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }

  return output;
};

const encodeSigned = (value: number): string => {
  let shifted = value < 0 ? ~(value << 1) : (value << 1);
  let encoded = "";
  while (shifted >= 0x20) {
    encoded += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
    shifted >>= 5;
  }
  encoded += String.fromCharCode(shifted + 63);
  return encoded;
};

test("decodeEncodedPolyline decodes known coordinates", () => {
  const encoded = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
  const decoded = decodeEncodedPolyline(encoded);

  assert.equal(decoded.length, 3);
  assert.ok(Math.abs(decoded[0].lat - 38.5) < 1e-5);
  assert.ok(Math.abs(decoded[0].lng + 120.2) < 1e-5);
});

test("DisabledRerouteService returns 503 error", async () => {
  const service = new DisabledRerouteService();

  await assert.rejects(
    () =>
      service.getAlternatives({
        origin: { lat: 1, lng: 1 },
        destination: { lat: 2, lng: 2 },
        avoidPoint: { lat: 1.5, lng: 1.5 },
        avoidRadiusMeters: 100
      }),
    (error: unknown) =>
      error instanceof RerouteServiceError && error.statusCode === 503
  );
});

test("GoogleRoutesRerouteService prioritizes non-intersecting route", async () => {
  const originalFetch = globalThis.fetch;
  const nearRoute = encodePolyline([
    { lat: 12.9716, lng: 77.5946 },
    { lat: 12.9718, lng: 77.5952 }
  ]);
  const farRoute = encodePolyline([
    { lat: 12.9808, lng: 77.6101 },
    { lat: 12.9812, lng: 77.6109 }
  ]);

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        routes: [
          {
            distanceMeters: 3000,
            duration: "720s",
            polyline: { encodedPolyline: nearRoute },
            routeLabels: ["DEFAULT_ROUTE"]
          },
          {
            distanceMeters: 3200,
            duration: "760s",
            polyline: { encodedPolyline: farRoute },
            routeLabels: ["DEFAULT_ROUTE_ALTERNATE"]
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch;

  try {
    const service = new GoogleRoutesRerouteService(
      "fake-key",
      "https://example.test/routes",
      3
    );
    const result = await service.getAlternatives({
      origin: { lat: 12.9716, lng: 77.5946 },
      destination: { lat: 12.9352, lng: 77.6245 },
      avoidPoint: { lat: 12.9717, lng: 77.595 },
      avoidRadiusMeters: 160
    });

    assert.equal(result.routes.length, 2);
    assert.equal(result.routes[0].intersectsAvoidZone, false);
    assert.equal(result.routes[0].recommended, true);
    assert.equal(result.selectedRouteId, result.routes[0].id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

