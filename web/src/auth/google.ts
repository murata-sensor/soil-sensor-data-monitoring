import * as legacy from "./legacyGoogle";
import { getFirebaseIdToken, signOutFirebase } from "./firebase";

export * from "./legacyGoogle";

export const isFirebaseAuthEnabled = import.meta.env.VITE_AUTH_PROVIDER === "firebase";

export function getValidIdToken(token: string): Promise<string> {
  return isFirebaseAuthEnabled ? getFirebaseIdToken(token) : legacy.getValidIdToken(token);
}

export function signOut(): void {
  if (isFirebaseAuthEnabled) signOutFirebase();
  else legacy.signOut();
}

export function getAccessToken(): Promise<string> {
  if (isFirebaseAuthEnabled) {
    return Promise.reject(new Error("Firebase認証では VITE_GAS_PROXY_URL の設定が必要です。"));
  }
  return legacy.getAccessToken();
}

export function requestConsentToken(): Promise<string> {
  return getAccessToken();
}
