import Redis from "ioredis";

import { AmbulanceState } from "../domain/types";

export interface AmbulanceStateStore {
  set(state: AmbulanceState, ttlSeconds: number): Promise<void>;
}

export class MemoryAmbulanceStateStore implements AmbulanceStateStore {
  private readonly states = new Map<string, AmbulanceState>();

  async set(state: AmbulanceState, _ttlSeconds: number): Promise<void> {
    this.states.set(state.ambulanceId, state);
  }
}

export class RedisAmbulanceStateStore implements AmbulanceStateStore {
  private readonly memoryFallback = new MemoryAmbulanceStateStore();
  private isRedisHealthy = true;
  private hasLoggedRedisDown = false;

  constructor(private readonly redis: Redis) {
    this.redis.on("error", (error) => {
      this.markRedisDown(error);
    });
    this.redis.on("end", () => {
      this.markRedisDown(new Error("Redis connection ended."));
    });
    this.redis.on("ready", () => {
      if (!this.isRedisHealthy) {
        console.info("[state-store] Redis connection restored.");
      }
      this.isRedisHealthy = true;
      this.hasLoggedRedisDown = false;
    });
  }

  async set(state: AmbulanceState, ttlSeconds: number): Promise<void> {
    if (!this.isRedisHealthy) {
      await this.memoryFallback.set(state, ttlSeconds);
      return;
    }

    try {
      await this.redis.set(
        `ambulance:state:${state.ambulanceId}`,
        JSON.stringify(state),
        "EX",
        ttlSeconds
      );
    } catch (error) {
      this.markRedisDown(error);
      await this.memoryFallback.set(state, ttlSeconds);
    }
  }

  private markRedisDown(error: unknown): void {
    this.isRedisHealthy = false;
    if (this.hasLoggedRedisDown) {
      return;
    }

    this.hasLoggedRedisDown = true;
    const message = error instanceof Error ? error.message : "Unknown Redis error";
    console.warn(
      `[state-store] Redis unavailable, using memory fallback: ${message}`
    );
  }
}

export const createAmbulanceStateStore = (
  redisUrl?: string
): AmbulanceStateStore => {
  if (!redisUrl) {
    return new MemoryAmbulanceStateStore();
  }

  return new RedisAmbulanceStateStore(
    new Redis(redisUrl, {
      maxRetriesPerRequest: 1
    })
  );
};
