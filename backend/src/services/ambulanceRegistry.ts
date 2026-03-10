import { AmbulanceIngress, AmbulanceState } from "../domain/types";
import { AmbulanceStateStore } from "./ambulanceStateStore";

export class AmbulanceRegistry {
  private readonly states = new Map<string, AmbulanceState>();

  constructor(
    private readonly store: AmbulanceStateStore,
    private readonly ttlSeconds: number
  ) {}

  async upsert(update: AmbulanceIngress): Promise<AmbulanceState> {
    const now = Date.now();
    const state: AmbulanceState = {
      ...update,
      updatedAt: now,
      expiresAt: now + this.ttlSeconds * 1000
    };

    this.states.set(update.ambulanceId, state);
    await this.store.set(state, this.ttlSeconds);
    return state;
  }

  pruneExpired(now = Date.now()): void {
    for (const [ambulanceId, state] of this.states.entries()) {
      if (state.expiresAt <= now) {
        this.states.delete(ambulanceId);
      }
    }
  }
}

