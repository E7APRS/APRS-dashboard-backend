/**
 * Runtime source manager.
 *
 * Allows starting and stopping data sources at runtime without a process
 * restart. Each source registers a factory that returns a stop function.
 */
import { DataSource, Position } from '../types';
import { markSourceEnabled, markSourceDisabled } from './source-health';
import { startAprsfiPoller } from './aprsfi';
import { startAprsis } from './aprsis';
import { startMeshtastic } from './meshtastic';
import { startMqttSource } from './mqtt-source';

type StopFn = () => void;
type SourceFactory = (onPosition: (pos: Position) => void) => StopFn;

const factories: Partial<Record<DataSource, SourceFactory>> = {
  aprsfi:     (cb) => startAprsfiPoller(cb),
  aprsis:     (cb) => startAprsis(cb),
  meshtastic: (cb) => startMeshtastic(cb),
  mqtt:       (cb) => startMqttSource(cb),
};

const running = new Map<DataSource, StopFn>();
// Push-based sources (DMR, relay) have no factory — they receive data via HTTP.
// This set tracks which push-based sources are currently accepting data.
const passiveEnabled = new Set<DataSource>();
let positionHandler: ((pos: Position) => void) | null = null;

/** Set the global position handler (called once at boot). */
export function setPositionHandler(handler: (pos: Position) => void): void {
  positionHandler = handler;
}

/** Start a source if it has a factory and is not already running. */
export function startSource(source: DataSource): boolean {
  if (running.has(source) || passiveEnabled.has(source)) return false;

  const factory = factories[source];
  if (factory) {
    if (!positionHandler) return false;
    const stop = factory(positionHandler);
    running.set(source, stop);
  } else {
    // Push-based source — just mark as accepting
    passiveEnabled.add(source);
  }

  markSourceEnabled(source);
  console.log(`[source-manager] Started: ${source}`);
  return true;
}

/** Stop a running source. */
export function stopSource(source: DataSource): boolean {
  const stop = running.get(source);
  if (stop) {
    stop();
    running.delete(source);
  } else if (passiveEnabled.has(source)) {
    passiveEnabled.delete(source);
  } else {
    return false;
  }

  markSourceDisabled(source);
  console.log(`[source-manager] Stopped: ${source}`);
  return true;
}

/** Get list of currently running sources (active + passive). */
export function getRunning(): DataSource[] {
  return [...running.keys(), ...passiveEnabled];
}

/** Check if a source is running (active or passive). */
export function isRunning(source: DataSource): boolean {
  return running.has(source) || passiveEnabled.has(source);
}

/** Check if a push-based source is accepting data. */
export function isAccepting(source: DataSource): boolean {
  return passiveEnabled.has(source);
}
