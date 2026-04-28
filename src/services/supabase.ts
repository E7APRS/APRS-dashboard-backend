import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

// Singleton — one client for the whole backend process
let client: SupabaseClient | null = null;

/** Returns true if Supabase URL and service role key are configured. */
export function isSupabaseConfigured(): boolean {
  return !!(config.supabase.url && config.supabase.serviceRoleKey);
}

export function getSupabase(): SupabaseClient {
  if (!client) {
    if (!isSupabaseConfigured()) {
      throw new Error('Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    }
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey);
  }
  return client;
}
