/**
 * Google Identity Services (GIS) auth helpers.
 *
 * - `signIn()` shows the Google one-tap / button and resolves a Google ID token
 *   (used by the GAS admin API).
 * - `getAccessToken()` requests an OAuth access token with the sheets.readonly
 *   scope used to read the spreadsheet directly from the browser.
 *
 * Sessions are persisted in localStorage so users stay signed in across
 * browser restarts.  Access tokens are refreshed silently when possible.
 */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

const STORAGE_KEY_USER = "soil_user";
const STORAGE_KEY_TOKEN = "soil_access_token";
const STORAGE_KEY_EXPIRY = "soil_access_token_expiry";
const STORAGE_KEY_LOGIN_AT = "soil_login_at";

/** Max days to keep the session alive without re-authentication. */
const SESSION_MAX_DAYS = 30;

let accessToken: string | null = localStorage.getItem(STORAGE_KEY_TOKEN);
let accessTokenExpiry = Number(localStorage.getItem(STORAGE_KEY_EXPIRY) || "0");

export interface SignedInUser {
  email: string;
  name?: string;
  picture?: string;
  idToken: string;
}

/** Restore user session from localStorage if still valid (up to SESSION_MAX_DAYS). */
export function restoreSession(): SignedInUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USER);
    if (!raw) return null;
    const loginAt = Number(localStorage.getItem(STORAGE_KEY_LOGIN_AT) || "0");
    if (loginAt && Date.now() - loginAt > SESSION_MAX_DAYS * 86_400_000) {
      // Session too old – force re-authentication
      localStorage.removeItem(STORAGE_KEY_USER);
      localStorage.removeItem(STORAGE_KEY_LOGIN_AT);
      return null;
    }
    return JSON.parse(raw) as SignedInUser;
  } catch {
    localStorage.removeItem(STORAGE_KEY_USER);
    return null;
  }
}

/** Check if the stored ID token JWT is expired. */
export function isIdTokenExpired(u: SignedInUser): boolean {
  try {
    const payload = decodeJwt(u.idToken) as { exp?: number };
    return !!(payload.exp && payload.exp * 1000 < Date.now());
  } catch {
    return true;
  }
}

/** Persist user to localStorage. */
function saveSession(u: SignedInUser): void {
  localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(u));
  // Only set login timestamp on first login (not on token refresh)
  if (!localStorage.getItem(STORAGE_KEY_LOGIN_AT)) {
    localStorage.setItem(STORAGE_KEY_LOGIN_AT, String(Date.now()));
  }
}

function saveAccessToken(): void {
  if (accessToken) {
    localStorage.setItem(STORAGE_KEY_TOKEN, accessToken);
    localStorage.setItem(STORAGE_KEY_EXPIRY, String(accessTokenExpiry));
  }
}

function decodeJwt(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const json = decodeURIComponent(
    atob(b64)
      .split("")
      .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
      .join(""),
  );
  return JSON.parse(json);
}

export function renderSignInButton(el: HTMLElement, onUser: (u: SignedInUser) => void): void {
  if (!window.google) {
    setTimeout(() => renderSignInButton(el, onUser), 200);
    return;
  }

  const handleCredential = (credential: string) => {
    const payload = decodeJwt(credential) as {
      email?: string; name?: string; picture?: string;
    };
    if (!payload.email) return;
    const u: SignedInUser = {
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      idToken: credential,
    };
    saveSession(u);
    // Immediately request OAuth token so user doesn't need a separate consent click.
    // Use empty prompt for silent refresh; falls back to consent popup if needed.
    requestToken("").catch(() => {
      // Silent refresh failed – will be handled when Dashboard tries getAccessToken()
    });
    onUser(u);
  };

  window.google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: (resp) => handleCredential(resp.credential),
    auto_select: true, // Enable auto-select for returning users (One Tap)
  });

  // Show One Tap prompt for returning users (no click needed)
  window.google.accounts.id.prompt();

  // Also render the button as fallback
  window.google.accounts.id.renderButton(el, { theme: "outline", size: "large" });
}

/**
 * Silently refresh the ID token using Google One Tap auto_select.
 * Returns the updated user or null if silent refresh is not possible.
 */
export function refreshIdToken(onRefreshed: (u: SignedInUser) => void): void {
  if (!window.google) return;
  window.google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: (resp) => {
      const payload = decodeJwt(resp.credential) as {
        email?: string; name?: string; picture?: string;
      };
      if (!payload.email) return;
      const u: SignedInUser = {
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
        idToken: resp.credential,
      };
      saveSession(u);
      onRefreshed(u);
    },
    auto_select: true,
  });
  // Trigger One Tap silently; if Google session is active it will auto-select
  window.google.accounts.id.prompt();
}

export class ConsentRequiredError extends Error {
  constructor() {
    super("CONSENT_REQUIRED");
    this.name = "ConsentRequiredError";
  }
}

export async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessTokenExpiry - 60_000) return accessToken;
  if (!window.google) throw new Error("Google Identity Services not loaded");
  // Try silent refresh first (no popup if consent was already granted)
  try {
    return await requestToken("");
  } catch (e) {
    if (e instanceof ConsentRequiredError) throw e;
    // Unknown error – re-throw as consent required so UI can handle it
    throw new ConsentRequiredError();
  }
}

/** Call from a click handler to grant Sheets access with explicit user gesture. */
export async function requestConsentToken(): Promise<string> {
  if (!window.google) throw new Error("Google Identity Services not loaded");
  return requestToken("consent");
}

/** Clear local session and revoke OAuth token when available. */
export function signOut(): void {
  const googleAny = window.google as unknown as {
    accounts?: {
      id?: { disableAutoSelect?: () => void };
      oauth2?: { revoke?: (token: string) => void };
    };
  };
  const tokenToRevoke = accessToken;
  accessToken = null;
  accessTokenExpiry = 0;
  localStorage.removeItem(STORAGE_KEY_USER);
  localStorage.removeItem(STORAGE_KEY_TOKEN);
  localStorage.removeItem(STORAGE_KEY_EXPIRY);
  localStorage.removeItem(STORAGE_KEY_LOGIN_AT);

  try {
    googleAny.accounts?.id?.disableAutoSelect?.();
  } catch {
    // Ignore GIS runtime errors during sign-out.
  }

  if (tokenToRevoke) {
    try {
      googleAny.accounts?.oauth2?.revoke?.(tokenToRevoke);
    } catch {
      // Ignore revoke errors; local session is already cleared.
    }
  }
}

function requestToken(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SHEETS_SCOPE,
      callback: (resp) => {
        if (!resp.access_token) return reject(new Error("no access_token"));
        accessToken = resp.access_token;
        accessTokenExpiry = Date.now() + resp.expires_in * 1000;
        saveAccessToken();
        resolve(resp.access_token);
      },
      error_callback: (err) => {
        if (err.type === "popup_closed" || err.type === "popup_blocked") {
          reject(new ConsentRequiredError());
        } else {
          reject(new Error(`OAuth token error: ${err.type || "unknown"}`));
        }
      },
    });
    client.requestAccessToken({ prompt });
  });
}
