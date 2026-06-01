/**
 * Google Identity Services (GIS) auth helpers.
 *
 * - `signIn()` shows the Google one-tap / button and resolves a Google ID token
 *   (used by the GAS admin API).
 * - `getAccessToken()` requests an OAuth access token with the sheets.readonly
 *   scope used to read the spreadsheet directly from the browser.
 */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

let accessToken: string | null = null;
let accessTokenExpiry = 0;

export interface SignedInUser {
  email: string;
  name?: string;
  picture?: string;
  idToken: string;
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
      onUser({
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
        idToken: resp.credential,
      });
    },
  });
  window.google.accounts.id.renderButton(el, { theme: "outline", size: "large" });
}

export async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessTokenExpiry - 60_000) return accessToken;
  if (!window.google) throw new Error("Google Identity Services not loaded");
  return new Promise<string>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SHEETS_SCOPE,
      callback: (resp) => {
        if (!resp.access_token) return reject(new Error("no access_token"));
        accessToken = resp.access_token;
        accessTokenExpiry = Date.now() + resp.expires_in * 1000;
        resolve(resp.access_token);
      },
    });
    client.requestAccessToken({ prompt: "" });
  });
}
