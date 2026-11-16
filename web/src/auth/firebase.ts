import { initializeApp } from "firebase/app";
import {
  browserLocalPersistence, browserSessionPersistence, getAuth, GoogleAuthProvider,
  onIdTokenChanged, setPersistence, signInWithPopup, signOut,
  type Auth, type User,
} from "firebase/auth";
import { SignInRequiredError, SIGN_IN_REQUIRED_EVENT, type SignedInUser } from "./legacyGoogle";

export const FIREBASE_AUTH_ERROR_EVENT = "soil:firebase-auth-error";
let auth: Auth | undefined;
let sessionVersion = 0;
let closed = false;
let signingIn = false;

function firebaseAuth(): Auth {
  if (auth) return auth;
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY?.trim();
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim();
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim();
  if (!apiKey || !projectId || !authDomain || !import.meta.env.VITE_GAS_PROXY_URL?.trim()) {
    throw new Error("Firebase認証の設定が不足しています。Firebaseの3項目と VITE_GAS_PROXY_URL を確認してください。");
  }
  // Do not carry the old, always-persistent Google credentials into this mode.
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of ["soil_user", "soil_login_at", "soil_access_token", "soil_access_token_expiry"]) {
      storage.removeItem(key);
    }
  }
  auth = getAuth(initializeApp({ apiKey, projectId, authDomain }));
  auth.languageCode = "ja";
  return auth;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

export function firebaseErrorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "ログインがキャンセルされました。もう一度操作してください。";
    case "auth/popup-blocked":
      return "ポップアップがブロックされました。このサイトのポップアップを許可してください。";
    case "auth/network-request-failed":
      return "認証サービスに接続できません。通信状態を確認して再試行してください。";
    case "auth/web-storage-unsupported":
    case "auth/unsupported-persistence-type":
      return "ログイン情報を保存できません。ブラウザーの保存設定を確認してください。";
    case "auth/unauthorized-domain":
      return "この公開ドメインがFirebaseで許可されていません。管理者に連絡してください。";
    case "auth/user-token-expired":
    case "auth/invalid-user-token":
    case "auth/user-disabled":
    case "auth/user-not-found":
      return "ログイン状態が終了しました。もう一度ログインしてください。";
    default:
      if (error instanceof SignInRequiredError) return "ログイン状態が終了しました。もう一度ログインしてください。";
      if (error instanceof Error && !errorCode(error)) return error.message;
      return "認証処理に失敗しました。再試行し、解消しない場合は管理者に連絡してください。";
  }
}

function requireCurrentUser(instance: Auth, user: User, version: number): void {
  if (closed || sessionVersion !== version || instance.currentUser !== user) throw new SignInRequiredError();
  if (!user.email || !user.emailVerified) throw new SignInRequiredError();
}

export function subscribeFirebaseSession(
  onUser: (user: SignedInUser | null) => void,
  onError: (error: unknown) => void,
): () => void {
  let instance: Auth;
  try {
    instance = firebaseAuth();
  } catch (error) {
    onError(error);
    return () => {};
  }
  let active = true;
  let delivery = 0;
  const unsubscribe = onIdTokenChanged(instance, (user) => {
    if (!active) return;
    const request = ++delivery;
    if (!user) {
      closed = true;
      sessionVersion += 1;
      onUser(null);
      return;
    }
    if (closed) {
      onUser(null);
      return;
    }
    const version = sessionVersion;
    void user.getIdToken().then((idToken) => {
      if (!active || request !== delivery || version !== sessionVersion) return;
      requireCurrentUser(instance, user, version);
      onUser({
        email: user.email!,
        name: user.displayName ?? undefined,
        picture: user.photoURL ?? undefined,
        idToken,
      });
    }).catch((error: unknown) => {
      if (active && request === delivery && version === sessionVersion) onError(error);
    });
  }, onError);
  return () => { active = false; delivery += 1; unsubscribe(); };
}

export async function signInFirebase(rememberDevice: boolean): Promise<void> {
  if (signingIn) throw new Error("ログイン処理中です。完了するまでお待ちください。");
  const instance = firebaseAuth();
  signingIn = true;
  const version = ++sessionVersion;
  try {
    await setPersistence(instance, rememberDevice ? browserLocalPersistence : browserSessionPersistence);
    if (version !== sessionVersion) throw new SignInRequiredError();
    closed = false;
    const result = await signInWithPopup(instance, new GoogleAuthProvider());
    if (version !== sessionVersion && closed && instance.currentUser === result.user) {
      await signOut(instance);
    }
    requireCurrentUser(instance, result.user, version);
  } finally {
    signingIn = false;
  }
}

export function signOutFirebase(): void {
  closed = true;
  sessionVersion += 1;
  try {
    void signOut(firebaseAuth()).catch((error: unknown) => {
      window.dispatchEvent(new CustomEvent(FIREBASE_AUTH_ERROR_EVENT, { detail: error }));
    });
  } catch (error) {
    window.dispatchEvent(new CustomEvent(FIREBASE_AUTH_ERROR_EVENT, { detail: error }));
  }
}

export async function getFirebaseIdToken(previousToken: string): Promise<string> {
  const instance = firebaseAuth();
  const version = sessionVersion;
  await instance.authStateReady();
  const user = instance.currentUser;
  if (!user) throw new SignInRequiredError();
  requireCurrentUser(instance, user, version);
  // Reject work from an old account, even before React receives the SDK event.
  const payload: { sub?: unknown; email?: unknown } = JSON.parse(
    atob(previousToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
  );
  if (payload.sub !== user.uid || typeof payload.email !== "string"
      || payload.email.trim().toLowerCase() !== user.email!.trim().toLowerCase()) {
    throw new SignInRequiredError();
  }
  try {
    const token = await user.getIdToken();
    requireCurrentUser(instance, user, version);
    return token;
  } catch (error) {
    if (["auth/user-token-expired", "auth/invalid-user-token", "auth/user-disabled", "auth/user-not-found"]
      .includes(errorCode(error) || "")) {
      signOutFirebase();
      window.dispatchEvent(new Event(SIGN_IN_REQUIRED_EVENT));
      throw new SignInRequiredError();
    }
    // A temporary network error must not delete the persisted session.
    throw error;
  }
}
