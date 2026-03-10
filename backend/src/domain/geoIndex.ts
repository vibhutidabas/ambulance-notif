import { LatLng } from "./types";
import { cellKeysAroundPoint } from "./spatial";

export class RouteSpatialIndex {
  private readonly cellToSessionIds = new Map<string, Set<string>>();
  private readonly sessionToCells = new Map<string, string[]>();

  constructor(private readonly cellSizeMeters: number) {}

  upsert(sessionId: string, cells: string[]): void {
    this.remove(sessionId);
    this.sessionToCells.set(sessionId, cells);

    for (const cell of cells) {
      const bucket = this.cellToSessionIds.get(cell) ?? new Set<string>();
      bucket.add(sessionId);
      this.cellToSessionIds.set(cell, bucket);
    }
  }

  remove(sessionId: string): void {
    const previousCells = this.sessionToCells.get(sessionId);
    if (!previousCells) {
      return;
    }

    for (const cell of previousCells) {
      const bucket = this.cellToSessionIds.get(cell);
      if (!bucket) {
        continue;
      }

      bucket.delete(sessionId);
      if (bucket.size === 0) {
        this.cellToSessionIds.delete(cell);
      }
    }

    this.sessionToCells.delete(sessionId);
  }

  query(points: LatLng[], radiusMeters: number): string[] {
    const sessionIds = new Set<string>();

    for (const point of points) {
      for (const cell of cellKeysAroundPoint(point, radiusMeters, this.cellSizeMeters)) {
        const bucket = this.cellToSessionIds.get(cell);
        if (!bucket) {
          continue;
        }

        for (const sessionId of bucket) {
          sessionIds.add(sessionId);
        }
      }
    }

    return [...sessionIds];
  }
}
