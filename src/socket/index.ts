import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { Position } from '../types';
import { config } from '../config';
import { getLatestPositions, getAllDevices, getHistory } from '../services/store';
import { getSupabase } from '../services/supabase';
import { getAllHealth } from '../services/source-health';
import { getActiveCapAlerts } from '../services/cap';
import { getAllGeofences } from '../services/geofence';

let io: SocketServer | null = null;

export function initSocket(server: HttpServer): SocketServer {
  io = new SocketServer(server, {
    cors: { origin: config.corsOrigins },
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) { next(new Error('Unauthorized')); return; }
    const { data: { user }, error } = await getSupabase().auth.getUser(token);
    if (error || !user) { next(new Error('Unauthorized')); return; }
    next();
  });

  function sendSnapshots(socket: import('socket.io').Socket): void {
    socket.emit('positions:snapshot', getLatestPositions());

    const historySnap: Record<string, Position[]> = {};
    for (const device of getAllDevices()) {
      const trail = getHistory(device.radioId);
      if (trail.length > 0) historySnap[device.radioId] = trail;
    }
    socket.emit('history:snapshot', historySnap);
    socket.emit('sources:health', getAllHealth());
    socket.emit('cap:alerts', getActiveCapAlerts());
    socket.emit('geofences:snapshot', getAllGeofences());
  }

  io.on('connection', socket => {
    console.log('[socket] Client connected:', socket.id);

    // Send current state to new client immediately
    sendSnapshots(socket);

    // Allow clients to re-request snapshots (e.g. after navigating back to the map)
    socket.on('snapshots:request', () => sendSnapshots(socket));

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
