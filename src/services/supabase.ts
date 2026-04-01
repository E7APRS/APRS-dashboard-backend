import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

// Singleton — one client for the whole backend process
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey);
  }
  return client;
}
