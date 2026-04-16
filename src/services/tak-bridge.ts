/**
 * TAK Server bridge — pushes CoT XML over TCP to a configured TAK Server.
 * Each position update is sent as a CoT event.
 */
import net from 'net';
import { config } from '../config';
import { Position } from '../types';
import { positionToCot } from '../utils/cot';

let client: net.Socket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function connect(): void {
  if (stopped || client) return;

  const { serverHost, serverPort } = config.tak;
  if (!serverHost) return;

  console.log(`[tak] Connecting to ${serverHost}:${serverPort}`);

  client = new net.Socket();

  client.connect(serverPort, serverHost, () => {
    console.log('[tak] Connected to TAK Server');
  });

  client.on('error', (err) => {
    console.warn('[tak] Connection error:', err.message);
  });

  client.on('close', () => {
    console.log('[tak] Connection closed');
    client = null;
    if (!stopped) {
      reconnectTimer = setTimeout(connect, 10_000);
    }
  });
}

export function sendToTak(pos: Position): void {
  if (!client || !config.tak.enabled) return;

  try {
    const xml = positionToCot(pos);
    client.write(xml + '\n');
  } catch (err) {
    console.warn('[tak] Send error:', (err as Error).message);
  }
}

export function startTakBridge(): () => void {
  if (!config.tak.enabled || !config.tak.serverHost) {
    console.log('[tak] TAK bridge disabled or no host configured');
    return () => {};
  }

  stopped = false;
  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (client) { client.destroy(); client = null; }
    console.log('[tak] Stopped');
  };
}
