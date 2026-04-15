-- Run this in Supabase SQL Editor to create the profiles backup table.
-- This mirrors the local SQLite profiles table for backup purposes.

CREATE TABLE IF NOT EXISTS profiles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id     TEXT UNIQUE NOT NULL,
  email       TEXT UNIQUE NOT NULL,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  address     TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',
  qth_locator TEXT NOT NULL DEFAULT '',
  callsign    TEXT NOT NULL,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_auth_id ON profiles(auth_id);
CREATE INDEX IF NOT EXISTS idx_profiles_email   ON profiles(email);

-- Enable RLS (Supabase best practice) but allow service_role full access
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Also ensure the devices table has the 'source' column (added in recent updates)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS source TEXT;

-- Ensure positions table has symbol columns (added in recent updates)
ALTER TABLE positions ADD COLUMN IF NOT EXISTS symbol TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS symbol_table TEXT;
