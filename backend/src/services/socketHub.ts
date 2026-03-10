import WebSocket from "ws";

import { DriverOutboundEvent } from "../domain/types";

export class SocketHub {
  private readonly driverSockets = new Map<string, WebSocket>();

  bindDriver(sessionId: string, socket: WebSocket): void {
    this.driverSockets.set(sessionId, socket);
  }

  unbindDriver(sessionId: string, socket: WebSocket): void {
    const current = this.driverSockets.get(sessionId);
    if (current === socket) {
      this.driverSockets.delete(sessionId);
    }
  }

  sendToDriver(sessionId: string, event: DriverOutboundEvent): boolean {
    const socket = this.driverSockets.get(sessionId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(JSON.stringify(event));
    return true;
  }
}

