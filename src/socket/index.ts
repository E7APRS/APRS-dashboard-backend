import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { Position } from '../types';
import { getLatestPositions } from '../services/store';

let io: SocketServer | null = null;

export function initSocket(server: HttpServer): SocketServer {
  io = new SocketServer(server, {
    cors: { origin: '*' },
  });

  io.on('connection', socket => {
    console.log('[socket] Client connected:', socket.id);

    // Send current state to new client immediately
    socket.emit('positions:snapshot', getLatestPositions());

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
