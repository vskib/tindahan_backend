import { createClient } from '@supabase/supabase-js';
import { AppError } from './errors.js';

/** Real Supabase-backed dependencies. The service role key never leaves this server process. */
export function createSupabaseDeps(config) {
  const admin = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const auth = {
    // Asks Supabase Auth to validate the access token (handles signature, expiry and revocation).
    async verifyToken(token) {
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data?.user) return null;
      return { id: data.user.id };
    },
    async createUser({ email, password, full_name }) {
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name },
      });
      if (error) {
        if (error.code === 'email_exists' || error.code === 'user_already_exists') {
          throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
        }
        if (error.code === 'weak_password') {
          throw new AppError(400, 'WEAK_PASSWORD', 'That password is too weak. Use a longer, less common password.');
        }
        const e = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
        e.cause = error;
        throw e;
      }
      return data.user.id;
    },
    async deleteUser(id) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
    },
    async setBanned(id, banned) {
      const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: banned ? '876000h' : 'none' });
      if (error) throw error;
    },
    async getEmail(id) {
      const { data } = await admin.auth.admin.getUserById(id);
      return data?.user?.email ?? null;
    },
  };
  return { db: admin, auth };
}
