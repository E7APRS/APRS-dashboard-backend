import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { Position } from '../types';
import { getLatestPositions, getAllDevices, getHistory } from '../services/store';

let io: SocketServer | null = null;

export function initSocket(server: HttpServer): SocketServer {
  io = new SocketServer(server, {
    cors: { origin: '*' },
  });

  io.on('connection', socket => {
    console.log('[socket] Client connected:', socket.id);

    // Send current state to new client immediately
    socket.emit('positions:snapshot', getLatestPositions());

    // Send trail history for all known devices
    const historySnap: Record<string, Position[]> = {};
    for (const device of getAllDevices()) {
      const trail = getHistory(device.radioId);
      if (trail.length > 0) historySnap[device.radioId] = trail;
    }
    socket.emit('history:snapshot', historySnap);

    socket.on('disconnect', () => {
      console.log('[socket] Client disconnected:', socket.id);
    });
  });

  return io;
}

export function broadcast(event: string, data: unknown): void {
  io?.emit(event, data);
}

export function broadcastPosition(pos: Position): void {
  broadcast('position:update', pos);
}
