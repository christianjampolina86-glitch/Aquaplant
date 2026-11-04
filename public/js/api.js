/**
 * AQUAPLANT: Shared API Client & Authentication Helper
 * Handles JWT token storage, request routing, and response parsing.
 */

const API_BASE = window.location.origin;

const TOKEN_KEY = 'aquaplant_auth_token';
const USER_KEY = 'aquaplant_auth_user';

export const Api = {
  // Token Management
  getToken() {
    return localStorage.getItem(TOKEN_KEY);
  },

  setToken(token) {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  },

  getUser() {
    try {
      const userStr = localStorage.getItem(USER_KEY);
      return userStr ? JSON.parse(userStr) : null;
    } catch (e) {
      return null;
    }
  },

  setUser(user) {
    if (user) {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(USER_KEY);
    }
  },

  isOfflineMode() {
    return localStorage.getItem('aquaplant_offline_mode') === 'true';
  },

  setOfflineMode(enabled, opName = 'Field Operator', stationName = 'Greenhouse Station') {
    if (enabled) {
      localStorage.removeItem('aquaplant_explicit_logout');
      localStorage.setItem('aquaplant_offline_mode', 'true');
      this.setToken('offline-field-' + Date.now());
      this.setUser({ username: `${opName} [${stationName}]`, role: 'admin' });
    } else {
      localStorage.removeItem('aquaplant_offline_mode');
    }
  },

  isAuthenticated() {
    if (this.isOfflineMode()) return true;
    const token = this.getToken();
    return Boolean(token);
  },

  logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem('aquaplant_offline_mode');
    localStorage.setItem('aquaplant_explicit_logout', 'true');
    window.location.href = '/login.html';
  },

  async requireAuth() {
    if (this.isOfflineMode()) return true;
    const hasExplicitlyLoggedOut = localStorage.getItem('aquaplant_explicit_logout') === 'true';
    if (hasExplicitlyLoggedOut || !this.isAuthenticated()) {
      window.location.replace('/login.html');
      return false;
    }
    return true;
  },

  // Generic HTTP Fetch Helper
  async request(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers
      });

      // Handle unauthenticated/expired sessions
      if (response.status === 401 || response.status === 403) {
        if (this.isOfflineMode()) {
          console.warn('[AQUAPLANT API] Running in offline mode; session logout bypassed.');
          return null;
        }
        if (!endpoint.includes('/api/auth/login')) {
          console.warn('[AQUAPLANT API] Session expired or unauthorized. Redirecting to login.');
          this.logout();
          return null;
        }
      }

      // Check if response is JSON
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || data.message || `Request failed with HTTP ${response.status}`);
        }
        return data;
      }

      // Return raw response for downloads (e.g. Excel export)
      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
      }
      return response;
    } catch (error) {
      console.error(`[API Error] ${endpoint}:`, error);
      throw error;
    }
  },

  // Auth Endpoints
  async login(username, password) {
    const data = await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    if (data.token) {
      localStorage.removeItem('aquaplant_explicit_logout');
      this.setToken(data.token);
      this.setUser(data.user);
    }
    return data;
  },

  async register(username, email, password) {
    const data = await this.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password })
    });
    if (data.token) {
      localStorage.removeItem('aquaplant_explicit_logout');
      this.setToken(data.token);
      this.setUser(data.user);
    }
    return data;
  },

  // Sensors Endpoints
  async getLatestSensors() {
    return await this.request('/api/sensors/latest');
  },

  async getSensorHistory(range = '24h') {
    return await this.request(`/api/sensors/history?range=${range}`);
  },

  // Controls Endpoints
  async getControls() {
    return await this.request('/api/controls');
  },

  async updateControl(device, state) {
    return await this.request(`/api/controls/${device}`, {
      method: 'POST',
      body: JSON.stringify({ state })
    });
  },

  async triggerManualFlush() {
    return await this.request('/api/controls/manual_flush', {
      method: 'POST'
    });
  },

  // Logs Endpoints
  async getLogs(limit = 50, level = 'ALL') {
    const query = level && level !== 'ALL' ? `?limit=${limit}&level=${level}` : `?limit=${limit}`;
    return await this.request(`/api/logs${query}`);
  },

  // Simulator Endpoint (For viva and capstone demo)
  async simulateTelemetry(payload) {
    return await this.request('/api/simulator/reading', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  // Excel Export Trigger
  async downloadExcel() {
    const token = this.getToken();
    const url = `${API_BASE}/api/export/excel`;
    
    // Fetch blob with authorization header
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Export failed with HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '_');
    a.download = `AQUAPLANT_Export_${timestamp}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(downloadUrl);
  }
};

// Also export to window for vanilla JS scripts
if (typeof window !== 'undefined') {
  window.Api = Api;
}
