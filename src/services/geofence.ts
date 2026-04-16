/**
 * Geofence service — CRUD + intersection checks.
 *
 * Geofences are stored as GeoJSON polygons in SQLite.
 * On each position update, checks if the device entered/exited any active fence.
 */
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point, polygon } from '@turf/helpers';
import { Position } from '../types';
import { queryAll, run, uuid, queryOne } from './database';
import { broadcast } from '../socket/index';

export interface Geofence {
  id: string;
  name: string;
  description: string;
  geometry: GeoJSON.Polygon;
  color: string;
  active: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GeofenceRow {
  id: string;
  name: string;
  description: string;
  geometry: string;
  color: string;
  active: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Track which devices are inside which fences
const deviceFenceState = new Map<string, Set<string>>();

function rowToGeofence(row: GeofenceRow): Geofence {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    geometry: JSON.parse(row.geometry),
    color: row.color,
    active: row.active === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAllGeofences(): Geofence[] {
  return queryAll<GeofenceRow>('SELECT * FROM geofences ORDER BY created_at DESC').map(rowToGeofence);
}

export function getActiveGeofences(): Geofence[] {
  return queryAll<GeofenceRow>('SELECT * FROM geofences WHERE active = 1').map(rowToGeofence);
}

export function getGeofence(id: string): Geofence | undefined {
  const row = queryOne<GeofenceRow>('SELECT * FROM geofences WHERE id = ?', [id]);
  return row ? rowToGeofence(row) : undefined;
}

export function createGeofence(data: {
  name: string;
  description?: string;
  geometry: GeoJSON.Polygon;
  color?: string;
  createdBy?: string;
}): Geofence {
  const id = uuid();
  const now = new Date().toISOString();
  run(
    `INSERT INTO geofences (id, name, description, geometry, color, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [id, data.name, data.description ?? '', JSON.stringify(data.geometry), data.color ?? '#ef4444', data.createdBy ?? null, now, now],
  );
  return getGeofence(id)!;
}

export function updateGeofence(id: string, data: Partial<{
  name: string;
  description: string;
  geometry: GeoJSON.Polygon;
  color: string;
  active: boolean;
}>): Geofence | undefined {
  const existing = getGeofence(id);
  if (!existing) return undefined;

  const updates: string[] = [];
  const params: unknown[] = [];

  if (data.name !== undefined) { updates.push('name = ?'); params.push(data.name); }
  if (data.description !== undefined) { updates.push('description = ?'); params.push(data.description); }
  if (data.geometry !== undefined) { updates.push('geometry = ?'); params.push(JSON.stringify(data.geometry)); }
  if (data.color !== undefined) { updates.push('color = ?'); params.push(data.color); }
  if (data.active !== undefined) { updates.push('active = ?'); params.push(data.active ? 1 : 0); }

  if (updates.length > 0) {
    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    run(`UPDATE geofences SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  return getGeofence(id);
}

export function deleteGeofence(id: string): boolean {
  const result = run('DELETE FROM geofences WHERE id = ?', [id]);
  return result.changes > 0;
}

/**
 * Check a position against all active geofences.
 * Emits geofence:alert via Socket.io on enter/exit transitions.
 */
export function checkGeofences(pos: Position): void {
  const fences = getActiveGeofences();
  if (fences.length === 0) return;

  const pt = point([pos.lon, pos.lat]);
  const currentFences = deviceFenceState.get(pos.radioId) ?? new Set();
  const newFences = new Set<string>();

  for (const fence of fences) {
    const poly = polygon(fence.geometry.coordinates);
    const inside = booleanPointInPolygon(pt, poly);

    if (inside) {
      newFences.add(fence.id);

      if (!currentFences.has(fence.id)) {
        broadcast('geofence:alert', {
          type: 'enter',
          radioId: pos.radioId,
          callsign: pos.callsign,
          fenceId: fence.id,
          fenceName: fence.name,
          lat: pos.lat,
          lon: pos.lon,
          timestamp: pos.timestamp,
        });
      }
    } else if (currentFences.has(fence.id)) {
      broadcast('geofence:alert', {
        type: 'exit',
        radioId: pos.radioId,
        callsign: pos.callsign,
        fenceId: fence.id,
        fenceName: fence.name,
        lat: pos.lat,
        lon: pos.lon,
        timestamp: pos.timestamp,
      });
    }
  }

  deviceFenceState.set(pos.radioId, newFences);
}
