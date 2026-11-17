/**
 * AQUAPLANT: Token storage helpers shared by the Administrator Portal.
 *
 * The operator dashboard (React app) only needs these four operations, so the
 * old fetch/endpoint wrappers were removed when the dashboard moved to its own
 * auth flow.
 */

const TOKEN_KEY = 'aquaplant_auth_token';
const USER_KEY = 'aquaplant_auth_user';
// Must match SESSION_STARTED_KEY in src/App.tsx. Without this marker the
// dashboard treats the launch as a cold start and shows the login screen, which
// would throw away a session created in the admin portal.
const SESSION_STARTED_KEY = 'aquaplant_session_started';

export const Api = {
  getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },

  setToken(token) {
    try {
      if (token) {
        localStorage.setItem(TOKEN_KEY, token);
        sessionStorage.setItem(SESSION_STARTED_KEY, '1');
      } else {
        localStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(SESSION_STARTED_KEY);
      }
    } catch {}
  },

  getUser() {
    try {
      const userStr = localStorage.getItem(USER_KEY);
      return userStr ? JSON.parse(userStr) : null;
    } catch {
      return null;
    }
  },

  setUser(user) {
    try {
      if (user) {
        localStorage.setItem(USER_KEY, JSON.stringify(user));
      } else {
        localStorage.removeItem(USER_KEY);
      }
    } catch {}
  }
};
