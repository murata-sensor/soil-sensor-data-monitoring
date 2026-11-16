import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";

interface TestUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  photoURL: string | null;
  getIdToken: ReturnType<typeof vi.fn>;
}

const sdk = vi.hoisted(() => ({
  instance: {
    currentUser: null as TestUser | null,
    authStateReady: vi.fn(),
    languageCode: "",
  },
  deliver: (_user: TestUser | null) => {},
  initializeApp: vi.fn(),
  setPersistence: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("firebase/app", () => ({ initializeApp: sdk.initializeApp }));
vi.mock("firebase/auth", () => ({
  getAuth: () => sdk.instance,
  GoogleAuthProvider: class {},
  browserLocalPersistence: { type: "LOCAL" },
  browserSessionPersistence: { type: "SESSION" },
  setPersistence: sdk.setPersistence,
  signInWithPopup: sdk.signInWithPopup,
  signOut: sdk.signOut,
  onIdTokenChanged: (_auth: unknown, callback: (user: TestUser | null) => void) => {
    sdk.deliver = callback;
    callback(sdk.instance.currentUser);
    return sdk.unsubscribe;
  },
}));

let issuedAt = 0;

function token(email = "viewer@example.test", uid = "synthetic-uid", seconds = 3600) {
  return `synthetic.${btoa(JSON.stringify({ sub: uid, email, exp: issuedAt + seconds }))}.signature`;
}

function user(email = "viewer@example.test", uid = "synthetic-uid"): TestUser {
  return {
    email, uid, emailVerified: true, displayName: null, photoURL: null,
    getIdToken: vi.fn().mockResolvedValue(token(email, uid)),
  };
}

beforeEach(() => {
  issuedAt = Math.floor(Date.now() / 1000);
  vi.stubEnv("VITE_AUTH_PROVIDER", "firebase");
  vi.stubEnv("VITE_FIREBASE_API_KEY", "synthetic-key");
  vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "synthetic-project");
  vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "synthetic-project.firebaseapp.com");
  vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.test/proxy");
  sdk.instance.currentUser = null;
  sdk.instance.authStateReady.mockResolvedValue(undefined);
  sdk.setPersistence.mockResolvedValue(undefined);
  sdk.signOut.mockImplementation(async () => { sdk.instance.currentUser = null; sdk.deliver(null); });
  sdk.signInWithPopup.mockImplementation(async () => {
    const signedIn = user();
    sdk.instance.currentUser = signedIn;
    sdk.deliver(signedIn);
    return { user: signedIn };
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
});

async function gate(strict = false) {
  const { default: LoginGate } = await import("../components/LoginGate");
  const contents = <LoginGate><p>synthetic-private-screen</p></LoginGate>;
  return render(strict ? <StrictMode>{contents}</StrictMode> : contents);
}

describe("Firebase login persistence and renewal", () => {
  it.each([false, true])("uses session-only storage unless remember-device is checked (%s)", async (remember) => {
    const view = await gate();
    const checkbox = view.getByRole("checkbox", { name: "この端末にログイン状態を保存する" });
    expect(checkbox).not.toBeChecked();
    if (remember) fireEvent.click(checkbox);
    fireEvent.click(view.getByRole("button", { name: "Googleでログイン" }));
    await waitFor(() => expect(view.getByText("synthetic-private-screen")).toBeInTheDocument());
    expect(sdk.setPersistence).toHaveBeenCalledWith(sdk.instance, { type: remember ? "LOCAL" : "SESSION" });
    expect(sdk.setPersistence.mock.invocationCallOrder[0]).toBeLessThan(sdk.signInWithPopup.mock.invocationCallOrder[0]);
    expect(sdk.signInWithPopup).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("soil_user")).toBeNull();
    expect(localStorage.getItem("soil_login_at")).toBeNull();
  });

  it.each([false, true])("restores an existing SDK session without a popup or a 30-day cutoff (StrictMode=%s)", async (strict) => {
    sdk.instance.currentUser = user();
    localStorage.setItem("soil_user", "synthetic-old-google-credential");
    localStorage.setItem("soil_access_token", "synthetic-old-access");
    localStorage.setItem("soil_login_at", String(Date.now() - 90 * 86_400_000));
    const view = await gate(strict);
    await waitFor(() => expect(view.getByText("synthetic-private-screen")).toBeInTheDocument());
    expect(sdk.signInWithPopup).not.toHaveBeenCalled();
    expect(sdk.setPersistence).not.toHaveBeenCalled();
    expect(localStorage.getItem("soil_user")).toBeNull();
    expect(localStorage.getItem("soil_access_token")).toBeNull();
    expect(localStorage.getItem("soil_login_at")).toBeNull();
  });

  it("uses the SDK to renew an expired token without requesting Google consent again", async () => {
    const auth = await import("../auth/google");
    sdk.instance.currentUser = user();
    await expect(auth.getValidIdToken(token("viewer@example.test", "synthetic-uid", -1))).resolves.toBe(token());
    expect(sdk.instance.currentUser.getIdToken).toHaveBeenCalledWith();
    expect(sdk.signInWithPopup).not.toHaveBeenCalled();
    expect(sdk.setPersistence).not.toHaveBeenCalled();
    await expect(auth.getAccessToken()).rejects.toThrow("VITE_GAS_PROXY_URL");
  });

  it("does not delete the persisted session on a transient token refresh failure", async () => {
    const auth = await import("../auth/google");
    const signedIn = user();
    sdk.instance.currentUser = signedIn;
    const offline = Object.assign(new Error("synthetic offline"), { code: "auth/network-request-failed" });
    signedIn.getIdToken.mockRejectedValueOnce(offline);
    await expect(auth.getValidIdToken(token())).rejects.toBe(offline);
    expect(sdk.signOut).not.toHaveBeenCalled();
    await expect(auth.getValidIdToken(token())).resolves.toBe(token());
  });

  it("blocks token use immediately on logout, even before Firebase finishes clearing storage", async () => {
    const auth = await import("../auth/google");
    sdk.instance.currentUser = user();
    sdk.signOut.mockReturnValue(new Promise(() => {}));
    auth.signOut();
    await expect(auth.getValidIdToken(token())).rejects.toThrow("SIGN_IN_REQUIRED");
    expect(sdk.instance.currentUser.getIdToken).not.toHaveBeenCalled();
  });

  it.each(["logout", "account-change"])("rejects a token renewal completed after %s", async (change) => {
    const auth = await import("../auth/google");
    const signedIn = user();
    sdk.instance.currentUser = signedIn;
    let finish: (value: string) => void = () => {};
    signedIn.getIdToken.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    const pending = auth.getValidIdToken(token());
    await Promise.resolve();
    if (change === "logout") auth.signOut();
    else sdk.instance.currentUser = user("other@example.test", "other-uid");
    finish(token());
    await expect(pending).rejects.toThrow("SIGN_IN_REQUIRED");
    expect(sdk.signOut).toHaveBeenCalledTimes(change === "logout" ? 1 : 0);
  });

  it("rejects old-account requests before calling the SDK for a token", async () => {
    const auth = await import("../auth/google");
    sdk.instance.currentUser = user("other@example.test", "other-uid");
    await expect(auth.getValidIdToken(token())).rejects.toThrow("SIGN_IN_REQUIRED");
    expect(sdk.instance.currentUser.getIdToken).not.toHaveBeenCalled();
  });

  it("clears the private screen when Firebase reports a logout from another tab", async () => {
    sdk.instance.currentUser = user();
    const view = await gate();
    await waitFor(() => expect(view.getByText("synthetic-private-screen")).toBeInTheDocument());
    act(() => { sdk.instance.currentUser = null; sdk.deliver(null); });
    expect(view.queryByText("synthetic-private-screen")).not.toBeInTheDocument();
    expect(view.getByRole("checkbox")).not.toBeChecked();
  });

  it("resets the remember-device choice after logout", async () => {
    const view = await gate();
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: "Googleでログイン" }));
    await waitFor(() => expect(view.getByText("synthetic-private-screen")).toBeInTheDocument());
    const auth = await import("../auth/google");
    await act(async () => { auth.signOut(); });
    expect(view.getByRole("checkbox")).not.toBeChecked();
  });

  it("does not restore a pending SDK identity after the session is closed", async () => {
    const signedIn = user();
    sdk.instance.currentUser = signedIn;
    let finish: (value: string) => void = () => {};
    signedIn.getIdToken.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    const view = await gate();
    act(() => { sdk.instance.currentUser = null; sdk.deliver(null); });
    await act(async () => { finish(token()); });
    expect(view.queryByText("synthetic-private-screen")).not.toBeInTheDocument();
  });

  it("reports failed logout cleanup and keeps the private screen closed", async () => {
    sdk.instance.currentUser = user();
    const view = await gate();
    await waitFor(() => expect(view.getByText("synthetic-private-screen")).toBeInTheDocument());
    sdk.signOut.mockRejectedValue(new Error("synthetic blocked storage"));
    const auth = await import("../auth/google");
    await act(async () => { auth.signOut(); });
    expect(view.queryByText("synthetic-private-screen")).not.toBeInTheDocument();
    expect(view.getByRole("alert")).toHaveTextContent("保存データを削除");
    await expect(auth.getValidIdToken(token())).rejects.toThrow("SIGN_IN_REQUIRED");
  });

  it("reports blocked storage without opening a popup or falling back to persistent login", async () => {
    sdk.setPersistence.mockRejectedValue(Object.assign(new Error("blocked"), { code: "auth/web-storage-unsupported" }));
    const view = await gate();
    fireEvent.click(view.getByRole("button", { name: "Googleでログイン" }));
    await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("保存設定"));
    expect(sdk.signInWithPopup).not.toHaveBeenCalled();
    expect(view.queryByText("synthetic-private-screen")).not.toBeInTheDocument();
  });

  it("shows configuration errors instead of silently using the old login flow", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "");
    const view = await gate();
    expect(view.getByRole("alert")).toHaveTextContent("設定が不足");
    expect(sdk.initializeApp).not.toHaveBeenCalled();
    expect(sdk.signInWithPopup).not.toHaveBeenCalled();
  });

  it("reports popup cancellation and allows retry", async () => {
    sdk.signInWithPopup.mockRejectedValueOnce(Object.assign(new Error("closed"), { code: "auth/popup-closed-by-user" }));
    const view = await gate();
    fireEvent.click(view.getByRole("button", { name: "Googleでログイン" }));
    await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("キャンセル"));
    fireEvent.click(view.getByRole("button", { name: "Googleでログイン" }));
    await waitFor(() => expect(view.getByText("synthetic-private-screen")).toBeInTheDocument());
  });
});
