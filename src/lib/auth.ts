const ACCESS_TOKEN_KEY  = 'tunegen_at';
const REFRESH_TOKEN_KEY = 'tunegen_rt';

// Drop session tokens stored under the pre-rename key names.
try { for (const k of ['tire' + 'pro_at', 'tire' + 'pro_rt', 'tire' + 'pro_settings_v1']) localStorage.removeItem(k); } catch { /* storage unavailable */ }

// In-memory cache — survives re-renders but not tab close
let _accessToken: string | null = null;

export function getAccessToken(): string | null {
  return _accessToken ?? localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  // Check sessionStorage first (non-persistent session), then localStorage ("keep me signed in")
  return sessionStorage.getItem(REFRESH_TOKEN_KEY) ?? localStorage.getItem(REFRESH_TOKEN_KEY);
}

/**
 * @param remember - true = "Keep me signed in" — persists across browser restarts (localStorage)
 *                   false = session only — cleared when tab/browser closes (sessionStorage)
 */
export function setTokens(accessToken: string, refreshToken: string, remember = false): void {
  _accessToken = accessToken;
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);

  if (remember) {
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    sessionStorage.removeItem(REFRESH_TOKEN_KEY); // clear any leftover session token
  } else {
    sessionStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    localStorage.removeItem(REFRESH_TOKEN_KEY); // don't persist across browser restarts
  }
}

export function setAccessToken(accessToken: string): void {
  _accessToken = accessToken;
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
}

export function clearTokens(): void {
  _accessToken = null;
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  sessionStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function getUserRole(): string | null {
  const token = getAccessToken();
  if (!token) return null;
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64));
    return payload.role ?? null;
  } catch {
    return null;
  }
}

export function isDemo(): boolean {
  return getUserRole() === 'demo';
}
