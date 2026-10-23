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

export const AUTH_STORAGE_FAILED_EVENT = "soil:auth-storage-failed";
let storageReadFailed = false;

function readStoredItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    storageReadFailed = true;
    window.dispatchEvent(new Event(AUTH_STORAGE_FAILED_EVENT));
    throw error;
  }
}

function removeStoredItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    window.dispatchEvent(new Event(AUTH_STORAGE_FAILED_EVENT));
    return;
  }
}

let accessToken: string | null = null;
let accessTokenExpiry = 0;
let sessionVersion = 0;
let sessionClosed = false;
let sessionEmail: string | null = null;
let identityRenewal: { email: string; promise: Promise<string>; cancel: () => void } | null = null;
let accessRenewal: { promise: Promise<string>; cancel: () => void } | null = null;
let initialStoredSession: { user: string | null; loginAt: string | null } | null = null;

try {
  initialStoredSession = { user: readStoredItem(STORAGE_KEY_USER), loginAt: readStoredItem(STORAGE_KEY_LOGIN_AT) };
  accessToken = readStoredItem(STORAGE_KEY_TOKEN);
  accessTokenExpiry = Number(readStoredItem(STORAGE_KEY_EXPIRY) || "0");
} catch {
  sessionClosed = true;
  accessToken = null;
  accessTokenExpiry = 0;
}

export const SIGN_IN_REQUIRED_EVENT = "soil:sign-in-required";
export const SESSION_CHANGED_EVENT = "soil:session-changed";

export class SignInRequiredError extends Error {
  constructor() {
    super("SIGN_IN_REQUIRED");
    this.name = "SignInRequiredError";
  }
}

export interface SignedInUser {
  email: string;
  name?: string;
  picture?: string;
  idToken: string;
}

function parseStoredUser(raw: string): SignedInUser {
  const user = JSON.parse(raw) as SignedInUser;
  if (!user || typeof user !== "object" || Array.isArray(user)
      || typeof user.email !== "string" || !user.email.trim()
      || typeof user.idToken !== "string" || !user.idToken
      || (user.name !== undefined && typeof user.name !== "string")
      || (user.picture !== undefined && typeof user.picture !== "string")) throw new SignInRequiredError();
  const claims = decodeJwt(user.idToken);
  if (typeof claims.email !== "string" || claims.email.trim().toLowerCase() !== user.email.trim().toLowerCase()
      || !Number.isFinite(claims.exp)) throw new SignInRequiredError();
  return user;
}

/** Restore user session from localStorage if still valid (up to SESSION_MAX_DAYS). */
export function restoreSession(): SignedInUser | null {
  if (sessionClosed) {
    if (storageReadFailed) window.dispatchEvent(new Event(AUTH_STORAGE_FAILED_EVENT));
    return null;
  }
  try {
    const raw = readStoredItem(STORAGE_KEY_USER);
    if (!raw) return null;
    const user = parseStoredUser(raw);
    const email = user.email.trim().toLowerCase();
    if (sessionEmail && sessionEmail !== email) {
      closeChangedSession();
      return null;
    }
    const storedLoginAt = readStoredItem(STORAGE_KEY_LOGIN_AT);
    if (initialStoredSession) {
      let initialEmail: string | null = null;
      try {
        if (initialStoredSession.user) initialEmail = parseStoredUser(initialStoredSession.user).email.trim().toLowerCase();
      } catch { /* An unreadable original identity cannot own the cached token. */ }
      if (initialEmail !== email || initialStoredSession.loginAt !== storedLoginAt) {
        closeChangedSession();
        return null;
      }
    }
    const loginAt = Number(storedLoginAt || "0");
    const now = Date.now();
    if (!Number.isFinite(loginAt) || loginAt <= 0 || loginAt > now
      || now - loginAt > SESSION_MAX_DAYS * 86_400_000) {
      signOut();
      return null;
    }
    initialStoredSession = null;
    sessionEmail = email;
    return user;
  } catch {
    if (storageReadFailed) closeChangedSession();
    else signOut();
    return null;
  }
}

function requireSession(expectedEmail?: string): SignedInUser {
  if (sessionClosed) throw new SignInRequiredError();
  const current = restoreSession();
  if (!current) {
    if (!sessionClosed) signOut();
    window.dispatchEvent(new Event(SIGN_IN_REQUIRED_EVENT));
    throw new SignInRequiredError();
  }
  if (expectedEmail && current.email.trim().toLowerCase() !== expectedEmail) {
    closeChangedSession();
    throw new SignInRequiredError();
  }
  return current;
}

/** Check if the stored ID token JWT is expired. */
export function isIdTokenExpired(u: SignedInUser): boolean {
  try {
    const payload = decodeJwt(u.idToken) as { exp?: number };
    return !Number.isFinite(payload.exp) || Number(payload.exp) * 1000 <= Date.now();
  } catch {
    return true;
  }
}

export function getValidIdToken(token: string): Promise<string> {
  let email: string;
  try {
    if (sessionClosed) throw new SignInRequiredError();
    const payload = decodeJwt(token);
    if (typeof payload.email !== "string" || !payload.email.trim()) throw new SignInRequiredError();
    email = payload.email.trim().toLowerCase();
    const stored = requireSession(email);
    const candidate = stored.idToken;
    const candidateClaims = decodeJwt(candidate);
    if (Number.isFinite(candidateClaims.exp) && Number(candidateClaims.exp) * 1000 > Date.now() + 60000) {
      return Promise.resolve(candidate);
    }
  } catch {
    window.dispatchEvent(new Event(SIGN_IN_REQUIRED_EVENT));
    return Promise.reject(new SignInRequiredError());
  }
  if (identityRenewal) {
    return identityRenewal.email === email ? identityRenewal.promise : Promise.reject(new SignInRequiredError());
  }
  const version = sessionVersion;
  let cancel = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    let settled = false;
    let waitTimer: number | undefined;
    const finish = (user?: SignedInUser) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.clearTimeout(waitTimer);
      if (version !== sessionVersion) {
        reject(new SignInRequiredError());
        return;
      }
      try {
        requireSession(email);
      } catch {
        reject(new SignInRequiredError());
        return;
      }
      if (!user) {
        reject(new SignInRequiredError());
        window.dispatchEvent(new Event(SIGN_IN_REQUIRED_EVENT));
        return;
      }
      try {
        saveSession(user, true);
      } catch {
        signOut();
        window.dispatchEvent(new Event(AUTH_STORAGE_FAILED_EVENT));
        window.dispatchEvent(new Event(SIGN_IN_REQUIRED_EVENT));
        reject(new SignInRequiredError());
        return;
      }
      resolve(user.idToken);
    };
    const timeout = window.setTimeout(() => finish(), 15000);
    cancel = () => finish();
    const initialize = () => {
      if (settled) return;
      if (version !== sessionVersion) { finish(); return; }
      if (!window.google) {
        waitTimer = window.setTimeout(initialize, 200);
        return;
      }
      try {
        // Loading the library must not revive an expired or changed session.
        requireSession(email);
        window.google.accounts.id.initialize({
          client_id: CLIENT_ID,
          auto_select: true,
          login_hint: email,
          callback: (response) => {
            try {
              const payload = decodeJwt(response.credential);
              const user: SignedInUser = {
                email: String(payload.email || "").trim().toLowerCase(),
                name: typeof payload.name === "string" ? payload.name : undefined,
                picture: typeof payload.picture === "string" ? payload.picture : undefined,
                idToken: response.credential,
              };
              finish(user.email === email && !isIdTokenExpired(user) ? user : undefined);
            } catch {
              finish();
            }
          },
        });
        window.google.accounts.id.prompt();
      } catch {
        finish();
      }
    };
    initialize();
  });
  identityRenewal = { email, promise, cancel: () => cancel() };
  const release = () => { if (identityRenewal?.promise === promise) identityRenewal = null; };
  void promise.then(release, release);
  return promise;
}

/** Persist user to localStorage. */
function saveSession(u: SignedInUser, renewal = false): void {
  if (!renewal) {
    // A fresh sign-in starts a new local session. The shared cache may belong
    // to another tab's account, so discard it without revoking that account.
    closeLocalSession(false);
    localStorage.removeItem(STORAGE_KEY_TOKEN);
    localStorage.removeItem(STORAGE_KEY_EXPIRY);
    const loginAt = Number(readStoredItem(STORAGE_KEY_LOGIN_AT) || "0");
    const now = Date.now();
    if (!Number.isFinite(loginAt) || loginAt <= 0 || loginAt > now
        || now - loginAt > SESSION_MAX_DAYS * 86_400_000) {
      localStorage.setItem(STORAGE_KEY_LOGIN_AT, String(now));
    }
  }
  localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(u));
  storageReadFailed = false;
  sessionClosed = false;
  sessionEmail = u.email.trim().toLowerCase();
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

export function renderSignInButton(el: HTMLElement, onUser: (u: SignedInUser) => void): () => void {
  const version = sessionVersion;
  let storedSession: { user: string | null; loginAt: string | null } | null = null;
  try {
    storedSession = { user: readStoredItem(STORAGE_KEY_USER), loginAt: readStoredItem(STORAGE_KEY_LOGIN_AT) };
  } catch {
    // Without the original state, a delayed response cannot safely replace it.
  }
  let active = true;
  let timer: number | undefined;
  const dispose = () => {
    active = false;
    window.clearTimeout(timer);
  };

  const handleCredential = (credential: string) => {
    if (!active || version !== sessionVersion) return;
    dispose();
    try {
      if (!storedSession) throw new SignInRequiredError();
      const currentUser = readStoredItem(STORAGE_KEY_USER);
      const currentLoginAt = readStoredItem(STORAGE_KEY_LOGIN_AT);
      if (currentUser !== storedSession.user || currentLoginAt !== storedSession.loginAt) {
        closeChangedSession();
        return;
      }
    } catch {
      closeChangedSession();
      window.dispatchEvent(new Event(AUTH_STORAGE_FAILED_EVENT));
      return;
    }
    let u: SignedInUser;
    try {
      const payload = decodeJwt(credential);
      if (typeof payload.email !== "string" || !payload.email.trim()
          || (payload.name !== undefined && typeof payload.name !== "string")
          || (payload.picture !== undefined && typeof payload.picture !== "string")) throw new SignInRequiredError();
      u = {
        email: payload.email,
        name: payload.name as string | undefined,
        picture: payload.picture as string | undefined,
        idToken: credential,
      };
      if (isIdTokenExpired(u)) throw new SignInRequiredError();
    } catch {
      signOut();
      window.dispatchEvent(new Event(SIGN_IN_REQUIRED_EVENT));
      return;
    }
    try {
      saveSession(u);
    } catch {
      signOut();
      window.dispatchEvent(new Event(AUTH_STORAGE_FAILED_EVENT));
      window.dispatchEvent(new Event(SIGN_IN_REQUIRED_EVENT));
      return;
    }
    // Immediately request OAuth token so user doesn't need a separate consent click.
    // Use empty prompt for silent refresh; falls back to consent popup if needed.
    if (!import.meta.env.VITE_GAS_PROXY_URL) {
      void requestToken("").catch(() => {});
    }
    onUser(u);
  };

  const initialize = () => {
    if (!active || version !== sessionVersion) return;
    if (!window.google) {
      timer = window.setTimeout(initialize, 200);
      return;
    }
    window.google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (resp) => handleCredential(resp.credential),
      auto_select: !sessionClosed,
      use_fedcm_for_button: true,
      // A click can reuse an approved account; after logout, allow choosing again.
      button_auto_select: !sessionClosed,
    });

    // Show One Tap prompt for returning users (no click needed)
    window.google.accounts.id.prompt();

    // Also render the button as fallback
    window.google.accounts.id.renderButton(el, { theme: "outline", size: "large" });
  };
  initialize();
  return dispose;
}

/**
 * Silently refresh the ID token using Google One Tap auto_select.
 * Returns the updated user or null if silent refresh is not possible.
 */
export function refreshIdToken(onRefreshed: (u: SignedInUser) => void): void {
  const current = restoreSession();
  if (!current) return;
  void getValidIdToken(current.idToken).then((idToken) => {
    onRefreshed({ ...current, idToken });
  }).catch(() => {});
}

export class ConsentRequiredError extends Error {
  constructor() {
    super("CONSENT_REQUIRED");
    this.name = "ConsentRequiredError";
  }
}

export async function getAccessToken(): Promise<string> {
  requireSession();
  if (accessToken && Number.isFinite(accessTokenExpiry) && Date.now() < accessTokenExpiry - 60_000) return accessToken;
  if (!window.google) throw new Error("Google Identity Services not loaded");
  // Try silent refresh first (no popup if consent was already granted)
  try {
    return await requestToken("");
  } catch (e) {
    if (e instanceof ConsentRequiredError || e instanceof SignInRequiredError) throw e;
    // Unknown error – re-throw as consent required so UI can handle it
    throw new ConsentRequiredError();
  }
}

/** Call from a click handler to grant Sheets access with explicit user gesture. */
export async function requestConsentToken(): Promise<string> {
  return getAccessToken();
}

function closeLocalSession(disableGoogleAutoSelect = true): void {
  sessionClosed = true;
  sessionEmail = null;
  initialStoredSession = null;
  sessionVersion += 1;
  identityRenewal?.cancel();
  identityRenewal = null;
  accessRenewal?.cancel();
  accessRenewal = null;
  const googleAny = window.google as unknown as {
    accounts?: {
      id?: { disableAutoSelect?: () => void };
    };
  };
  accessToken = null;
  accessTokenExpiry = 0;

  try {
    if (disableGoogleAutoSelect) googleAny?.accounts?.id?.disableAutoSelect?.();
  } catch {
    // Ignore GIS runtime errors during sign-out.
  }
}

function closeChangedSession(): void {
  closeLocalSession();
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
}

export function syncSessionFromStorage(event: StorageEvent, email?: string): boolean {
  try {
    if (event.storageArea !== localStorage) return false;
  } catch {
    closeLocalSession();
    window.dispatchEvent(new Event(AUTH_STORAGE_FAILED_EVENT));
    return true;
  }
  if (event.key === STORAGE_KEY_USER && event.newValue !== null) {
    try {
      const next = parseStoredUser(event.newValue);
      if (email && next.email.trim().toLowerCase() === email.trim().toLowerCase()) return false;
    } catch {
      closeLocalSession();
      return true;
    }
  } else if (event.key !== null && (event.newValue !== null
      || ![STORAGE_KEY_USER, STORAGE_KEY_TOKEN, STORAGE_KEY_EXPIRY, STORAGE_KEY_LOGIN_AT].includes(event.key))) {
    return false;
  }
  closeLocalSession();
  return true;
}

/** Clear local session and revoke OAuth token when available. */
export function signOut(): void {
  const tokenToRevoke = accessToken;
  closeLocalSession();
  removeStoredItem(STORAGE_KEY_USER);
  removeStoredItem(STORAGE_KEY_TOKEN);
  removeStoredItem(STORAGE_KEY_EXPIRY);
  removeStoredItem(STORAGE_KEY_LOGIN_AT);
  const googleAny = window.google as unknown as {
    accounts?: { oauth2?: { revoke?: (token: string) => void } };
  };

  if (tokenToRevoke) {
    try {
      googleAny?.accounts?.oauth2?.revoke?.(tokenToRevoke);
    } catch {
      // Ignore revoke errors; local session is already cleared.
    }
  }
}

function requestToken(prompt: string): Promise<string> {
  let email: string;
  try {
    email = requireSession().email.trim().toLowerCase();
  } catch {
    return Promise.reject(new SignInRequiredError());
  }
  if (accessRenewal) return accessRenewal.promise;
  const version = sessionVersion;
  let cancel = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      reject(error);
    };
    const timeout = window.setTimeout(() => fail(new ConsentRequiredError()), 120000);
    cancel = () => fail(new SignInRequiredError());
    try {
      const client = window.google!.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SHEETS_SCOPE,
        login_hint: email,
        callback: (resp) => {
          if (settled) return;
          if (version !== sessionVersion) return fail(new SignInRequiredError());
          try {
            requireSession(email);
          } catch {
            return fail(new SignInRequiredError());
          }
          const lifetime = Number(resp.expires_in);
          const expiresAt = Date.now() + lifetime * 1000;
          if (!resp.access_token || !Number.isFinite(lifetime) || lifetime <= 0 || !Number.isFinite(expiresAt)) {
            return fail(new ConsentRequiredError());
          }
          try {
            accessToken = resp.access_token;
            accessTokenExpiry = expiresAt;
            saveAccessToken();
            settled = true;
            window.clearTimeout(timeout);
            resolve(resp.access_token);
          } catch {
            fail(new SignInRequiredError());
            signOut();
            window.dispatchEvent(new Event(AUTH_STORAGE_FAILED_EVENT));
            window.dispatchEvent(new Event(SIGN_IN_REQUIRED_EVENT));
          }
        },
        error_callback: () => fail(new ConsentRequiredError()),
      });
      client.requestAccessToken({ prompt });
    } catch {
      fail(new ConsentRequiredError());
    }
  });
  accessRenewal = { promise, cancel: () => cancel() };
  const release = () => { if (accessRenewal?.promise === promise) accessRenewal = null; };
  void promise.then(release, release);
  return promise;
}
