import express, { Express } from "express";

import {
  RerouteOptionsRequest,
  RerouteService,
  RerouteServiceError
} from "../services/rerouteService";
import { LatLng } from "../domain/types";

interface Dependencies {
  rerouteService: RerouteService;
}

export const createHttpApp = ({ rerouteService }: Dependencies): Express => {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", (_request, response) => {
    response.json({
      ok: true,
      service: "ambulance-alert-backend",
      timestamp: Date.now()
    });
  });

  app.post("/reroute-options", async (request, response) => {
    const parsed = parseRerouteRequest(request.body);
    if (!parsed.ok) {
      response.status(400).json({
        ok: false,
        error: parsed.error
      });
      return;
    }

    try {
      const result = await rerouteService.getAlternatives(parsed.value);
      response.json({
        ok: true,
        ...result
      });
    } catch (error) {
      if (error instanceof RerouteServiceError) {
        response.status(error.statusCode).json({
          ok: false,
          error: error.message
        });
        return;
      }

      response.status(500).json({
        ok: false,
        error: "Unexpected reroute service error."
      });
    }
  });

  return app;
};

const parseRerouteRequest = (
  body: unknown
): { ok: true; value: RerouteOptionsRequest } | { ok: false; error: string } => {
  const record = body as Record<string, unknown> | null;
  if (!record) {
    return { ok: false, error: "Request body is required." };
  }

  const origin = asLatLng(record.origin);
  const destination = asLatLng(record.destination);
  const avoidPoint = asLatLng(record.avoidPoint);
  const avoidRadiusMeters = asPositiveNumber(record.avoidRadiusMeters);

  if (!origin || !destination || !avoidPoint || !avoidRadiusMeters) {
    return {
      ok: false,
      error:
        "Invalid payload. Required fields: origin, destination, avoidPoint, avoidRadiusMeters."
    };
  }

  const alternativeCount = asOptionalNumber(record.alternativeCount);

  return {
    ok: true,
    value: {
      origin,
      destination,
      avoidPoint,
      avoidRadiusMeters,
      alternativeCount
    }
  };
};

const asLatLng = (value: unknown): LatLng | null => {
  const record = value as Record<string, unknown> | null;
  if (
    !record ||
    typeof record.lat !== "number" ||
    typeof record.lng !== "number"
  ) {
    return null;
  }

  return {
    lat: record.lat,
    lng: record.lng
  };
};

const asPositiveNumber = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value;
};

const asOptionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
};

