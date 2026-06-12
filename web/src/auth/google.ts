/**
 * Google Identity Services (GIS) auth helpers.
 *
 * - `signIn()` shows the Google one-tap / button and resolves a Google ID token
 *   (used by the GAS admin API).
 * - `getAccessToken()` requests an OAuth access token with the sheets.readonly
 *   scope used to read the spreadsheet directly from the browser.
 *
 * Sessions are persisted in sessionStorage so users don't have to re-auth on reload.
 */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

const STORAGE_KEY_USER = "soil_user";
const STORAGE_KEY_TOKEN = "soil_access_token";
const STORAGE_KEY_EXPIRY = "soil_access_token_expiry";

let accessToken: string | null = sessionStorage.getItem(STORAGE_KEY_TOKEN);
let accessTokenExpiry = Number(sessionStorage.getItem(STORAGE_KEY_EXPIRY) || "0");

export interface SignedInUser {
  email: string;
  name?: string;
  picture?: string;
  idToken: string;
}

/** Restore user session from sessionStorage if still valid. */
export function restoreSession(): SignedInUser | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY_USER);
    if (!raw) return null;
    const u = JSON.parse(raw) as SignedInUser;
    // Check JWT not expired
    const payload = decodeJwt(u.idToken) as { exp?: number };
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY_USER);
      return null;
    }
    return u;
  } catch {
    return null;
  }
}

/** Persist user to sessionStorage. */
function saveSession(u: SignedInUser): void {
  sessionStorage.setItem(STORAGE_KEY_USER, JSON.stringify(u));
}

function saveAccessToken(): void {
  if (accessToken) {
    sessionStorage.setItem(STORAGE_KEY_TOKEN, accessToken);
    sessionStorage.setItem(STORAGE_KEY_EXPIRY, String(accessTokenExpiry));
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
      onUser(u);
    },
  });
  window.google.accounts.id.renderButton(el, { theme: "outline", size: "large" });
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
  return requestToken("");
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
  sessionStorage.removeItem(STORAGE_KEY_USER);
  sessionStorage.removeItem(STORAGE_KEY_TOKEN);
  sessionStorage.removeItem(STORAGE_KEY_EXPIRY);

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
