import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { queryOne, run, uuid } from '../services/database';
import { getSupabase } from '../services/supabase';
import { config } from '../config';
import { UserProfile } from '../types';

const router = Router();

// Derive avatars dir from the same base directory as the SQLite database
// so both live on the persistent volume in production (Fly.io)
const AVATARS_DIR = path.join(path.dirname(config.sqlite.path), 'avatars');

/** Map a DB row to a UserProfile. */
function rowToProfile(row: Record<string, unknown>): UserProfile {
  return {
    id:        row.id as string,
    authId:    row.auth_id as string,
    email:     row.email as string,
    firstName: row.first_name as string,
    lastName:  row.last_name as string,
    address:   row.address as string,
    city:      row.city as string,
    country:   row.country as string,
    qthLocator: row.qth_locator as string,
    callsign:  row.callsign as string,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// GET /api/auth/profile — get current user's profile
router.get('/profile', (_req: Request, res: Response) => {
  const authId = _req.authUserId;
  if (!authId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    const row = queryOne<Record<string, unknown>>(
      'SELECT * FROM profiles WHERE auth_id = ?',
      [authId],
    );

    if (!row) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    res.json(rowToProfile(row));
  } catch (err) {
    console.error('[auth] profile fetch error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/profile — create or update profile
router.post('/profile', (_req: Request, res: Response) => {
  const authId = _req.authUserId;
  if (!authId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { firstName, lastName, email, address, city, country, qthLocator, callsign } = _req.body;

  if (!firstName || !lastName || !email || !address || !city || !callsign) {
    res.status(400).json({
      error: 'Required fields: firstName, lastName, email, address, city, callsign',
    });
    return;
  }

  try {
    const now = new Date().toISOString();

    const existing = queryOne<Record<string, unknown>>(
      'SELECT id FROM profiles WHERE auth_id = ?',
      [authId],
    );

    const safeCountry = country ?? '';
    const safeQth = qthLocator ?? '';

    if (existing) {
      run(
        `UPDATE profiles SET email = ?, first_name = ?, last_name = ?, address = ?, city = ?, country = ?, qth_locator = ?, callsign = ?, updated_at = ?
         WHERE auth_id = ?`,
        [email, firstName, lastName, address, city, safeCountry, safeQth, callsign, now, authId],
      );
    } else {
      const id = uuid();
      run(
        `INSERT INTO profiles (id, auth_id, email, first_name, last_name, address, city, country, qth_locator, callsign, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, authId, email, firstName, lastName, address, city, safeCountry, safeQth, callsign, now, now],
      );
    }

    const row = queryOne<Record<string, unknown>>(
      'SELECT * FROM profiles WHERE auth_id = ?',
      [authId],
    );
    const profile = rowToProfile(row!);

    backupProfileToSupabase(profile).catch(() => {});

    res.json(profile);
  } catch (err) {
    console.error('[auth] profile upsert error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/avatar — upload avatar image (base64 in JSON body)
router.post('/avatar', (_req: Request, res: Response) => {
  const authId = _req.authUserId;
  if (!authId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { image } = _req.body as { image?: string };
  if (!image || !image.startsWith('data:image/')) {
    res.status(400).json({ error: 'Invalid image data' });
    return;
  }

  try {
    // Parse data URI: data:image/png;base64,iVBOR...
    const match = image.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
      res.status(400).json({ error: 'Invalid image format' });
      return;
    }

    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const buffer = Buffer.from(match[2], 'base64');

    // Max 2 MB
    if (buffer.length > 2 * 1024 * 1024) {
      res.status(400).json({ error: 'Image too large (max 2 MB)' });
      return;
    }

    fs.mkdirSync(AVATARS_DIR, { recursive: true });

    const filename = `${authId}.${ext}`;
    fs.writeFileSync(path.join(AVATARS_DIR, filename), buffer);

    const avatarUrl = `/avatars/${filename}`;
    const now = new Date().toISOString();

    run(
      'UPDATE profiles SET avatar_url = ?, updated_at = ? WHERE auth_id = ?',
      [avatarUrl, now, authId],
    );

    const row = queryOne<Record<string, unknown>>(
      'SELECT * FROM profiles WHERE auth_id = ?',
      [authId],
    );

    const profile = rowToProfile(row!);
    backupProfileToSupabase(profile).catch(() => {});

    res.json(profile);
  } catch (err) {
    console.error('[auth] avatar upload error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Mirror profile to Supabase backup. */
async function backupProfileToSupabase(profile: UserProfile): Promise<void> {
  try {
    const { error } = await getSupabase().from('profiles').upsert({
      id:         profile.id,
      auth_id:    profile.authId,
      email:      profile.email,
      first_name: profile.firstName,
      last_name:  profile.lastName,
      address:    profile.address,
      city:       profile.city,
      country:    profile.country,
      qth_locator: profile.qthLocator,
      callsign:   profile.callsign,
      avatar_url: profile.avatarUrl,
      created_at: profile.createdAt,
      updated_at: profile.updatedAt,
    }, { onConflict: 'auth_id' });

    if (error) {
      console.warn('[auth] Supabase profile backup failed:', error.message);
    } else {
      console.log('[auth] Supabase profile backup OK:', profile.callsign);
    }
  } catch (err) {
    console.warn('[auth] Supabase profile backup error:', (err as Error).message);
  }
}

export default router;
