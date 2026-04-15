import { Request, Response, NextFunction } from 'express';
import { getSupabase } from '../services/supabase';

/** Extends Express Request with the authenticated Supabase user ID. */
declare global {
  namespace Express {
    interface Request {
      authUserId?: string;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice(7);
  const { data: { user }, error } = await getSupabase().auth.getUser(token);

  if (error || !user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Attach the Supabase user ID so downstream handlers can use it
  req.authUserId = user.id;

  next();
}
