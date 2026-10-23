import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";

const DAY = 86_400_000;

function identityToken(seconds = 3600): string {
  return `synthetic.${btoa(JSON.stringify({ email: "viewer@example.test", exp: Math.floor(Date.now() / 1000) + seconds }))}.signature`;
}

function storeSession(loginAt: number): string {
  const token = identityToken(-1);
  localStorage.setItem("soil_user", JSON.stringify({ email: "viewer@example.test", idToken: token }));
  localStorage.setItem("soil_login_at", String(loginAt));
  return token;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("account changes before storage notifications arrive", () => {
  function storeOtherUser(): string {
    const idToken = `synthetic.${btoa(JSON.stringify({ email: "other@example.test", exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
    const raw = JSON.stringify({ email: "other@example.test", idToken });
    localStorage.setItem("soil_user", raw);
    localStorage.setItem("soil_login_at", String(Date.now()));
    localStorage.setItem("soil_access_token", "synthetic-other-access");
    localStorage.setItem("soil_access_token_expiry", String(Date.now() + 3600000));
    return raw;
  }

  it("closes the old screen without removing or revoking the other account", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.test/proxy");
    storeSession(Date.now());
    const token = identityToken();
    const user = { email: "viewer@example.test", idToken: token };
    localStorage.setItem("soil_user", JSON.stringify(user));
    const revoke = vi.fn();
    vi.stubGlobal("google", { accounts: {
      id: { initialize: vi.fn(), prompt: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn() },
      oauth2: { revoke },
    } });
    const auth = await import("../auth/google");
    const { useApp } = await import("../store");
    useApp.getState().setUser(user);
    const { default: LoginGate } = await import("../components/LoginGate");
    const view = render(createElement(LoginGate, null, createElement("p", null, "synthetic-private-screen")));
    await act(async () => {});
    const other = storeOtherUser();
    await act(async () => { await expect(auth.getValidIdToken(token)).rejects.toThrow("SIGN_IN_REQUIRED"); });
    expect(useApp.getState().user).toBeNull();
    expect(view.queryByText("synthetic-private-screen")).not.toBeInTheDocument();
    expect(view.getByRole("alert")).toHaveTextContent("別のタブ");
    expect(localStorage.getItem("soil_user")).toBe(other);
    expect(localStorage.getItem("soil_access_token")).toBe("synthetic-other-access");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("preserves the other account when the login gate remounts before storage notification", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.test/proxy");
    storeSession(Date.now());
    const token = identityToken();
    const user = { email: "viewer@example.test", idToken: token };
    localStorage.setItem("soil_user", JSON.stringify(user));
    const revoke = vi.fn();
    vi.stubGlobal("google", { accounts: {
      id: { initialize: vi.fn(), prompt: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn() },
      oauth2: { revoke },
    } });
    const auth = await import("../auth/google");
    const { useApp } = await import("../store");
    useApp.getState().setUser(user);
    const { default: LoginGate } = await import("../components/LoginGate");
    const first = render(createElement(LoginGate, null, createElement("p", null, "synthetic-private-screen")));
    await act(async () => {});
    first.unmount();
    useApp.getState().setUser(null);
    const other = storeOtherUser();
    const view = render(createElement(LoginGate, null, createElement("p", null, "synthetic-private-screen")));
    await act(async () => { await expect(auth.getValidIdToken(token)).rejects.toThrow("SIGN_IN_REQUIRED"); });
    expect(localStorage.getItem("soil_user")).toBe(other);
    expect(localStorage.getItem("soil_access_token")).toBe("synthetic-other-access");
    expect(revoke).not.toHaveBeenCalled();
    expect(view.getByRole("alert")).toHaveTextContent("別のタブ");
    expect(view.queryByText("synthetic-private-screen")).not.toBeInTheDocument();
  });

  it.each(["identity", "access"])("does not save a pending %s response over the other account", async (kind) => {
    const token = storeSession(Date.now());
    let deliverIdentity: (response: { credential: string }) => void = () => {};
    let deliverAccess: (response: { access_token: string; expires_in: number }) => void = () => {};
    const revoke = vi.fn();
    vi.stubGlobal("google", { accounts: {
      id: { initialize: vi.fn((options) => { deliverIdentity = options.callback; }), prompt: vi.fn(), disableAutoSelect: vi.fn() },
      oauth2: { revoke, initTokenClient: vi.fn((options) => {
        deliverAccess = options.callback;
        return { requestAccessToken: vi.fn() };
      }) },
    } });
    const auth = await import("../auth/google");
    const pending = expect(kind === "identity" ? auth.getValidIdToken(token) : auth.getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
    const other = storeOtherUser();
    if (kind === "identity") deliverIdentity({ credential: identityToken() });
    else deliverAccess({ access_token: "synthetic-late-access", expires_in: 3600 });
    await pending;
    expect(localStorage.getItem("soil_user")).toBe(other);
    expect(localStorage.getItem("soil_access_token")).toBe("synthetic-other-access");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("does not reuse the old account's cached OAuth token", async () => {
    storeSession(Date.now());
    localStorage.setItem("soil_access_token", "synthetic-old-access");
    localStorage.setItem("soil_access_token_expiry", String(Date.now() + 3600000));
    const auth = await import("../auth/google");
    expect(auth.restoreSession()).not.toBeNull();
    const other = storeOtherUser();
    await expect(auth.getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
    expect(localStorage.getItem("soil_user")).toBe(other);
    expect(localStorage.getItem("soil_access_token")).toBe("synthetic-other-access");
  });
});

describe("session lifetime at authentication boundaries", () => {
  it.each(["cached", "silent", "consent"])("rejects %s Sheets access after 30 days without contacting Google", async (mode) => {
    storeSession(Date.now() - 31 * DAY);
    if (mode === "cached") {
      localStorage.setItem("soil_access_token", "synthetic-cached-access");
      localStorage.setItem("soil_access_token_expiry", String(Date.now() + 3600000));
    }
    const initialize = vi.fn(() => ({ requestAccessToken: vi.fn() }));
    vi.stubGlobal("google", { accounts: { oauth2: { initTokenClient: initialize } } });
    const auth = await import("../auth/google");
    await expect(mode === "consent" ? auth.requestConsentToken() : auth.getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
    expect(initialize).not.toHaveBeenCalled();
    expect(localStorage.getItem("soil_access_token")).toBeNull();
  });

  it.each(["missing-user", "missing-time", "invalid-time", "malformed-user"])("rejects OAuth with %s session data", async (kind) => {
    storeSession(Date.now());
    if (kind === "missing-user") localStorage.removeItem("soil_user");
    if (kind === "missing-time") localStorage.removeItem("soil_login_at");
    if (kind === "invalid-time") localStorage.setItem("soil_login_at", "Infinity");
    if (kind === "malformed-user") localStorage.setItem("soil_user", "{}");
    localStorage.setItem("soil_access_token", "synthetic-cached-access");
    localStorage.setItem("soil_access_token_expiry", String(Date.now() + 3600000));
    const initialize = vi.fn();
    vi.stubGlobal("google", { accounts: { oauth2: { initTokenClient: initialize } } });
    const auth = await import("../auth/google");
    await expect(auth.getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
    expect(initialize).not.toHaveBeenCalled();
  });

  it("rejects a cached OAuth token when active-session storage becomes unreadable", async () => {
    storeSession(Date.now());
    localStorage.setItem("soil_access_token", "synthetic-cached-access");
    localStorage.setItem("soil_access_token_expiry", String(Date.now() + 3600000));
    const auth = await import("../auth/google");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("synthetic blocked storage", "SecurityError"); });
    await expect(auth.getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
  });

  it("does not extend the first login time when identity renewal crosses the 30-day limit", async () => {
    vi.useFakeTimers();
    const token = storeSession(Date.now() - 30 * DAY + 1000);
    let deliver: (response: { credential: string }) => void = () => {};
    vi.stubGlobal("google", { accounts: { id: {
      initialize: vi.fn((options) => { deliver = options.callback; }), prompt: vi.fn(),
    } } });
    const auth = await import("../auth/google");
    const pending = expect(auth.getValidIdToken(token)).rejects.toThrow("SIGN_IN_REQUIRED");
    await vi.advanceTimersByTimeAsync(2000);
    deliver({ credential: identityToken() });
    await pending;
    expect(localStorage.getItem("soil_user")).toBeNull();
    expect(localStorage.getItem("soil_login_at")).toBeNull();
  });

  it.each(["silent", "consent"])("rejects %s OAuth completion after the 30-day limit", async (mode) => {
    vi.useFakeTimers();
    storeSession(Date.now() - 30 * DAY + 1000);
    let deliver: (response: { access_token: string; expires_in: number }) => void = () => {};
    vi.stubGlobal("google", { accounts: { oauth2: { initTokenClient: vi.fn((options) => {
      deliver = options.callback;
      return { requestAccessToken: vi.fn() };
    }) } } });
    const auth = await import("../auth/google");
    const pending = expect(mode === "consent" ? auth.requestConsentToken() : auth.getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
    await vi.advanceTimersByTimeAsync(2000);
    deliver({ access_token: "synthetic-late-access", expires_in: 3600 });
    await pending;
    expect(localStorage.getItem("soil_access_token")).toBeNull();
    expect(localStorage.getItem("soil_login_at")).toBeNull();
  });

  it("starts a new session after explicit sign-in beyond the original limit", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.test/proxy");
    storeSession(Date.now() - 31 * DAY);
    let deliver: (response: { credential: string }) => void = () => {};
    vi.stubGlobal("google", { accounts: { id: {
      initialize: vi.fn((options) => { deliver = options.callback; }), prompt: vi.fn(), renderButton: vi.fn(),
    } } });
    const auth = await import("../auth/google");
    const onUser = vi.fn();
    auth.renderSignInButton(document.createElement("div"), onUser);
    const before = Date.now();
    deliver({ credential: identityToken() });
    expect(onUser).toHaveBeenCalledTimes(1);
    expect(Number(localStorage.getItem("soil_login_at"))).toBeGreaterThanOrEqual(before);
    expect(auth.restoreSession()?.email).toBe("viewer@example.test");
  });
});
