import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, useState } from "react";
import { toCsv } from "../csv";
import type { SourceRow } from "../types";

vi.mock("../auth/google", async (importOriginal) => ({
  ...await importOriginal<typeof import("../auth/google")>(),
  getAccessToken: vi.fn().mockResolvedValue("synthetic-access"),
  getValidIdToken: vi.fn(async (token: string) => token),
}));

const source: SourceRow = {
  sourceId: "synthetic-source", displayName: "synthetic", schemaType: "mechatrax",
  spreadsheetId: "synthetic-book", sheetName: "measurements", headerRow: 1,
  siteId: "synthetic-site", tz: "Asia/Tokyo", accessMode: "direct", enabled: true,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

function identityToken(email: string, seconds = 3600): string {
  const payload = btoa(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + seconds }));
  return `synthetic.${payload}.signature`;
}

function storeAuthSession(seconds = 3600): string {
  const token = identityToken("viewer@example.test", seconds);
  localStorage.setItem("soil_user", JSON.stringify({ email: "viewer@example.test", idToken: token }));
  localStorage.setItem("soil_login_at", String(Date.now()));
  return token;
}

describe("sign-in callback lifecycle", () => {
  async function fixture(loaded = true) {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
    let deliver: (response: { credential: string }) => void = () => {};
    const initialize = vi.fn((options) => { deliver = options.callback; });
    const revoke = vi.fn();
    const sdk = { accounts: {
      id: { initialize, prompt: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn() },
      oauth2: { revoke },
    } };
    vi.stubGlobal("google", loaded ? sdk : undefined);
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    return { auth, sdk, initialize, revoke, deliver: (credential: string) => deliver({ credential }) };
  }

  it("ignores a sign-in response delivered after sign-out", async () => {
    const { auth, deliver } = await fixture();
    const onUser = vi.fn();
    auth.renderSignInButton(document.createElement("div"), onUser);
    auth.signOut();
    deliver(identityToken("viewer@example.test"));
    expect(onUser).not.toHaveBeenCalled();
    expect(auth.restoreSession()).toBeNull();
    expect(localStorage.getItem("soil_user")).toBeNull();
  });

  it.each(["valid", "malformed"])("ignores a late %s response without changing another tab's credentials", async (kind) => {
    const { auth, deliver, revoke } = await fixture();
    const onUser = vi.fn();
    auth.renderSignInButton(document.createElement("div"), onUser);
    const newValue = JSON.stringify({ email: "other@example.test", idToken: identityToken("other@example.test") });
    localStorage.setItem("soil_user", newValue);
    localStorage.setItem("soil_login_at", String(Date.now()));
    localStorage.setItem("soil_access_token", "synthetic-other-access");
    auth.syncSessionFromStorage(new StorageEvent("storage", {
      key: "soil_user", newValue, storageArea: localStorage,
    }), "viewer@example.test");
    const remaining = { ...localStorage };
    const dispatch = vi.spyOn(window, "dispatchEvent");
    deliver(kind === "valid" ? identityToken("viewer@example.test") : "broken");
    expect(onUser).not.toHaveBeenCalled();
    expect({ ...localStorage }).toEqual(remaining);
    expect(dispatch).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each(["valid", "malformed"])("ignores a %s response after the button is disposed", async (kind) => {
    const { auth, deliver } = await fixture();
    const onUser = vi.fn();
    const dispose = auth.renderSignInButton(document.createElement("div"), onUser);
    expect(dispose).toBeTypeOf("function");
    dispose();
    const dispatch = vi.spyOn(window, "dispatchEvent");
    deliver(kind === "valid" ? identityToken("viewer@example.test") : "broken");
    expect(onUser).not.toHaveBeenCalled();
    expect(localStorage.getItem("soil_user")).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stops SDK polling when the button is disposed", async () => {
    vi.useFakeTimers();
    const { auth, sdk, initialize } = await fixture(false);
    const dispose = auth.renderSignInButton(document.createElement("div"), vi.fn());
    expect(dispose).toBeTypeOf("function");
    dispose();
    vi.stubGlobal("google", sdk);
    await vi.advanceTimersByTimeAsync(1000);
    expect(initialize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not initialize an old sign-in button if sign-out occurs while the SDK loads", async () => {
    vi.useFakeTimers();
    const { auth, sdk, initialize } = await fixture(false);
    auth.renderSignInButton(document.createElement("div"), vi.fn());
    auth.signOut();
    vi.stubGlobal("google", sdk);
    await vi.advanceTimersByTimeAsync(1000);
    expect(initialize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts an active sign-in only once and ignores later responses", async () => {
    const { auth, deliver } = await fixture();
    const onUser = vi.fn();
    auth.renderSignInButton(document.createElement("div"), onUser);
    const token = identityToken("viewer@example.test");
    deliver(token);
    deliver(identityToken("other@example.test"));
    deliver("broken");
    expect(onUser).toHaveBeenCalledTimes(1);
    expect(auth.restoreSession()).toMatchObject({ email: "viewer@example.test", idToken: token });
  });

  it("allows sign-in when the SDK finishes loading for an active button", async () => {
    vi.useFakeTimers();
    const { auth, sdk, initialize, deliver } = await fixture(false);
    const onUser = vi.fn();
    auth.renderSignInButton(document.createElement("div"), onUser);
    vi.stubGlobal("google", sdk);
    await vi.advanceTimersByTimeAsync(200);
    deliver(identityToken("viewer@example.test"));
    await vi.advanceTimersByTimeAsync(0);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(onUser).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes the sign-in handler when the login gate unmounts", async () => {
    const { auth, initialize, deliver } = await fixture();
    const api = await import("../auth/google");
    vi.spyOn(api, "renderSignInButton").mockImplementation(auth.renderSignInButton);
    vi.spyOn(api, "restoreSession").mockImplementation(auth.restoreSession);
    const { useApp } = await import("../store");
    useApp.getState().setUser(null);
    const { default: LoginGate } = await import("../components/LoginGate");
    const view = render(createElement(LoginGate, { children: createElement("p", null, "synthetic-protected-screen") }));
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    view.unmount();
    act(() => { deliver(identityToken("viewer@example.test")); });
    expect(useApp.getState().user).toBeNull();
    expect(localStorage.getItem("soil_user")).toBeNull();
  });

  it.each(["account-change", "invalid-response"])("allows a new sign-in after %s while already signed out", async (change) => {
    const { auth, initialize, deliver } = await fixture();
    const api = await import("../auth/google");
    vi.spyOn(api, "renderSignInButton").mockImplementation(auth.renderSignInButton);
    vi.spyOn(api, "restoreSession").mockImplementation(auth.restoreSession);
    vi.spyOn(api, "signOut").mockImplementation(auth.signOut);
    vi.spyOn(api, "syncSessionFromStorage").mockImplementation(auth.syncSessionFromStorage);
    const { useApp } = await import("../store");
    useApp.getState().setUser(null);
    const { default: LoginGate } = await import("../components/LoginGate");
    const view = render(createElement(LoginGate, { children: createElement("p", null, "synthetic-protected-screen") }));
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    const oldCallback = initialize.mock.calls[0][0].callback;
    act(() => {
      if (change === "invalid-response") deliver("broken");
      else {
        const newValue = JSON.stringify({ email: "other@example.test", idToken: identityToken("other@example.test") });
        localStorage.setItem("soil_user", newValue);
        localStorage.setItem("soil_login_at", String(Date.now()));
        window.dispatchEvent(new StorageEvent("storage", { key: "soil_user", newValue, storageArea: localStorage }));
      }
    });
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(2));
    act(() => { deliver(identityToken("viewer@example.test")); });
    expect(view.getByText("synthetic-protected-screen")).toBeInTheDocument();
    const remaining = { ...localStorage };
    act(() => { oldCallback({ credential: identityToken("other@example.test") }); });
    expect(useApp.getState().user?.email).toBe("viewer@example.test");
    expect({ ...localStorage }).toEqual(remaining);
  });
});

describe("OAuth requests after session closure", () => {
  async function fixture() {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
    let signIn: (response: { credential: string }) => void = () => {};
    const requestAccessToken = vi.fn();
    const initialize = vi.fn((options) => ({ requestAccessToken: () => {
      requestAccessToken();
      options.callback({ access_token: "synthetic-new-access", expires_in: 3600 });
    } }));
    vi.stubGlobal("google", { accounts: {
      id: {
        initialize: vi.fn((options) => { signIn = options.callback; }),
        prompt: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn(),
      },
      oauth2: { initTokenClient: initialize, revoke: vi.fn() },
    } });
    localStorage.setItem("soil_user", JSON.stringify({
      email: "viewer@example.test", idToken: identityToken("viewer@example.test"),
    }));
    localStorage.setItem("soil_login_at", String(Date.now()));
    localStorage.setItem("soil_access_token", "synthetic-old-access");
    localStorage.setItem("soil_access_token_expiry", String(Date.now() + 3600000));
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    return { auth, initialize, requestAccessToken, signIn: () => signIn({ credential: identityToken("viewer@example.test") }) };
  }

  it.each([
    { closure: "sign-out", method: "getAccessToken" },
    { closure: "sign-out", method: "requestConsentToken" },
    { closure: "other-tab", method: "getAccessToken" },
    { closure: "other-tab", method: "requestConsentToken" },
  ] as const)("rejects $method after $closure without starting Google authorization", async ({ closure, method }) => {
    const { auth, initialize, requestAccessToken } = await fixture();
    if (closure === "sign-out") auth.signOut();
    else {
      const newValue = JSON.stringify({ email: "other@example.test", idToken: identityToken("other@example.test") });
      localStorage.setItem("soil_user", newValue);
      localStorage.setItem("soil_access_token", "synthetic-other-access");
      expect(auth.syncSessionFromStorage(new StorageEvent("storage", {
        key: "soil_user", newValue, storageArea: localStorage,
      }), "viewer@example.test")).toBe(true);
    }
    const remaining = { ...localStorage };
    await expect(auth[method]()).rejects.toThrow("SIGN_IN_REQUIRED");
    expect(initialize).not.toHaveBeenCalled();
    expect(requestAccessToken).not.toHaveBeenCalled();
    expect({ ...localStorage }).toEqual(remaining);
  });

  it.each(["getAccessToken", "requestConsentToken"] as const)(
    "allows %s again after a successful fresh sign-in", async (method) => {
      const { auth, initialize, requestAccessToken, signIn } = await fixture();
      auth.signOut();
      const onUser = vi.fn();
      auth.renderSignInButton(document.createElement("div"), onUser);
      signIn();
      expect(onUser).toHaveBeenCalledWith(expect.objectContaining({ email: "viewer@example.test" }));
      await expect(auth[method]()).resolves.toBe("synthetic-new-access");
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(requestAccessToken).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem("soil_access_token")).toBe("synthetic-new-access");
    },
  );
});

describe("cross-tab authentication changes", () => {
  async function fixture() {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
    const disableAutoSelect = vi.fn();
    const revoke = vi.fn();
    vi.stubGlobal("google", { accounts: {
      id: { initialize: vi.fn(), prompt: vi.fn(), renderButton: vi.fn(), disableAutoSelect },
      oauth2: { revoke },
    } });
    const user = { email: "viewer@example.test", idToken: identityToken("viewer@example.test") };
    localStorage.setItem("soil_user", JSON.stringify(user));
    localStorage.setItem("soil_login_at", String(Date.now()));
    localStorage.setItem("soil_access_token", "synthetic-first-access");
    localStorage.setItem("soil_access_token_expiry", String(Date.now() + 3600000));
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const api = await import("../auth/google");
    vi.spyOn(api, "syncSessionFromStorage").mockImplementation(auth.syncSessionFromStorage);
    vi.spyOn(api, "restoreSession").mockImplementation(auth.restoreSession);
    vi.spyOn(api, "signOut").mockImplementation(auth.signOut);
    const { useApp } = await import("../store");
    useApp.getState().setUser(user);
    function Draft() {
      const [value, setValue] = useState("synthetic-protected-screen");
      return createElement("button", { onClick: () => setValue("synthetic-unsaved-draft") }, value);
    }
    const { default: LoginGate } = await import("../components/LoginGate");
    const view = render(createElement(LoginGate, { children: createElement(Draft) }));
    await waitFor(() => expect(view.getByRole("button")).toBeInTheDocument());
    return { auth, useApp, user, view, disableAutoSelect, revoke };
  }

  it.each(["soil_user", "soil_login_at", "soil_access_token", "soil_access_token_expiry", null])(
    "closes the local screen when another tab removes authentication data: %s", async (key) => {
      const { auth, useApp, view, revoke } = await fixture();
      const oldValue = key ? localStorage.getItem(key) : null;
      if (key) localStorage.removeItem(key);
      else localStorage.clear();
      const remaining = { ...localStorage };
      act(() => { window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue: null, storageArea: localStorage })); });
      expect(view.queryByText("synthetic-protected-screen")).not.toBeInTheDocument();
      expect(useApp.getState().user).toBeNull();
      expect(auth.restoreSession()).toBeNull();
      expect({ ...localStorage }).toEqual(remaining);
      expect(revoke).not.toHaveBeenCalled();
    },
  );

  it("closes the old account without deleting or revoking the new account's shared credentials", async () => {
    const { auth, useApp, user, view, revoke, disableAutoSelect } = await fixture();
    const oldValue = localStorage.getItem("soil_user");
    const newValue = JSON.stringify({ email: "other@example.test", idToken: identityToken("other@example.test") });
    localStorage.setItem("soil_user", newValue);
    localStorage.setItem("soil_access_token", "synthetic-other-access");
    const remaining = { ...localStorage };
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "soil_user", oldValue, newValue, storageArea: localStorage })); });
    expect(view.queryByText("synthetic-protected-screen")).not.toBeInTheDocument();
    expect(useApp.getState().user).toBeNull();
    expect(auth.restoreSession()).toBeNull();
    expect({ ...localStorage }).toEqual(remaining);
    await act(async () => { await expect(auth.getValidIdToken(user.idToken)).rejects.toThrow("SIGN_IN_REQUIRED"); });
    expect({ ...localStorage }).toEqual(remaining);
    expect(revoke).not.toHaveBeenCalled();
    expect(disableAutoSelect).toHaveBeenCalled();
  });

  it.each(["same-account", "dashboard-settings", "session-storage"])(
    "preserves the current screen and its draft for %s changes", async (change) => {
      const { useApp, view, user } = await fixture();
      fireEvent.click(view.getByRole("button"));
      const event = change === "dashboard-settings"
        ? { key: "soil-sensor-settings-viewer@example.test", newValue: "{}", storageArea: localStorage }
        : { key: "soil_user", newValue: JSON.stringify({ ...user, email: "VIEWER@example.test", idToken: identityToken(user.email, 7200) }),
          storageArea: change === "session-storage" ? sessionStorage : localStorage };
      act(() => { window.dispatchEvent(new StorageEvent("storage", event)); });
      expect(useApp.getState().user?.email).toBe(user.email);
      expect(view.getByRole("button")).toHaveTextContent("synthetic-unsaved-draft");
    },
  );

  it("ignores storage notifications after the login gate unmounts", async () => {
    const { useApp, view, user, disableAutoSelect } = await fixture();
    view.unmount();
    window.dispatchEvent(new StorageEvent("storage", { key: "soil_user", newValue: null, storageArea: localStorage }));
    expect(useApp.getState().user).toEqual(user);
    expect(disableAutoSelect).not.toHaveBeenCalled();
  });

  it("cancels pending identity and access renewals without overwriting the other account", async () => {
    storeAuthSession(-1);
    let identityResponse: (response: { credential: string }) => void = () => {};
    let accessResponse: (response: { access_token: string; expires_in: number }) => void = () => {};
    vi.stubGlobal("google", { accounts: {
      id: { initialize: vi.fn((options) => { identityResponse = options.callback; }), prompt: vi.fn(), disableAutoSelect: vi.fn() },
      oauth2: { initTokenClient: vi.fn((options) => {
        accessResponse = options.callback;
        return { requestAccessToken: vi.fn() };
      }) },
    } });
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const identity = expect(auth.getValidIdToken(identityToken("viewer@example.test", -1))).rejects.toThrow("SIGN_IN_REQUIRED");
    const access = expect(auth.getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
    const newValue = JSON.stringify({ email: "other@example.test", idToken: identityToken("other@example.test") });
    localStorage.setItem("soil_user", newValue);
    localStorage.setItem("soil_access_token", "synthetic-other-access");
    expect(auth.syncSessionFromStorage(new StorageEvent("storage", {
      key: "soil_user", newValue, storageArea: localStorage,
    }), "viewer@example.test")).toBe(true);
    identityResponse({ credential: identityToken("viewer@example.test") });
    accessResponse({ access_token: "synthetic-late-access", expires_in: 3600 });
    await Promise.all([identity, access]);
    expect(localStorage.getItem("soil_user")).toBe(newValue);
    expect(localStorage.getItem("soil_access_token")).toBe("synthetic-other-access");
  });

  it("does not restore an old screen if storage changes during initial authentication", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
    vi.stubGlobal("google", { accounts: { id: {
      initialize: vi.fn(), prompt: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn(),
    } } });
    const user = { email: "viewer@example.test", idToken: identityToken("viewer@example.test") };
    localStorage.setItem("soil_user", JSON.stringify(user));
    localStorage.setItem("soil_login_at", String(Date.now()));
    const { useApp } = await import("../store");
    useApp.getState().setUser(null);
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const api = await import("../auth/google");
    vi.spyOn(api, "syncSessionFromStorage").mockImplementation(auth.syncSessionFromStorage);
    vi.spyOn(api, "restoreSession").mockImplementation(auth.restoreSession);
    vi.spyOn(api, "signOut").mockImplementation(auth.signOut);
    let complete: (token: string) => void = () => {};
    vi.mocked(api.getValidIdToken).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const { default: LoginGate } = await import("../components/LoginGate");
    const view = render(createElement(LoginGate, { children: createElement("p", null, "synthetic-protected-screen") }));
    expect(api.getValidIdToken).toHaveBeenCalledWith(user.idToken);
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "soil_user", newValue: null, storageArea: localStorage }));
      complete(user.idToken);
    });
    expect(useApp.getState().user).toBeNull();
    expect(view.queryByText("synthetic-protected-screen")).not.toBeInTheDocument();
  });
});

describe("persisted identity validation", () => {
  it.each(["broken", "expired", "email-type", "expiration-type"])(
    "rejects invalid Google sign-in callbacks without keeping a session: %s", async (kind) => {
      vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
      let deliver: (response: { credential: string }) => void = () => {};
      vi.stubGlobal("google", { accounts: { id: {
        initialize: vi.fn((options) => { deliver = options.callback; }), prompt: vi.fn(), renderButton: vi.fn(),
      } } });
      const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
      const payload = { email: kind === "email-type" ? {} : "viewer@example.test",
        exp: kind === "expiration-type" ? "Infinity" : Math.floor(Date.now() / 1000) + 3600 };
      const token = kind === "broken" ? "broken"
        : kind === "expired" ? identityToken("viewer@example.test", -1)
        : `synthetic.${btoa(JSON.stringify(payload))}.signature`;
      const onUser = vi.fn();
      const dispatch = vi.spyOn(window, "dispatchEvent");
      auth.renderSignInButton(document.createElement("div"), onUser);
      expect(() => deliver({ credential: token })).not.toThrow();
      expect(onUser).not.toHaveBeenCalled();
      expect(auth.restoreSession()).toBeNull();
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: auth.SIGN_IN_REQUIRED_EVENT }));
    },
  );

  it.each([null, "", "broken", "0", "-1", "Infinity", "NaN", "future", "expired"])(
    "requires sign-in when the stored login time is invalid: %s", async (time) => {
      const now = Date.now();
      const storedTime = time === "future" ? String(now + 60000)
        : time === "expired" ? String(now - 31 * 86400000) : time;
      localStorage.setItem("soil_user", JSON.stringify({
        email: "viewer@example.test", idToken: identityToken("viewer@example.test"),
      }));
      if (storedTime !== null) localStorage.setItem("soil_login_at", storedTime);
      localStorage.setItem("soil_access_token", "synthetic-old-access");
      localStorage.setItem("soil_access_token_expiry", String(now + 3600000));
      const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
      expect(auth.restoreSession()).toBeNull();
      for (const key of ["soil_user", "soil_login_at", "soil_access_token", "soil_access_token_expiry"]) {
        expect(localStorage.getItem(key)).toBeNull();
      }
    },
  );

  it.each([null, [], {}, { email: 42, idToken: "synthetic" },
    { email: "viewer@example.test", idToken: 42 },
    { email: "viewer@example.test", idToken: "broken" },
    { email: "viewer@example.test", idToken: identityToken("other@example.test") },
    { email: "viewer@example.test", idToken: identityToken("viewer@example.test"), name: {} },
    { email: "viewer@example.test", idToken: identityToken("viewer@example.test"), picture: [] },
  ].map(user => ({ user })))("rejects malformed saved identities: %j", async ({ user }) => {
    localStorage.setItem("soil_user", JSON.stringify(user));
    localStorage.setItem("soil_login_at", String(Date.now()));
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    expect(auth.restoreSession()).toBeNull();
    expect(localStorage.getItem("soil_user")).toBeNull();
  });

  it("restores a well-formed session and keeps its original login time during renewal", async () => {
    const loginAt = String(Date.now() - 7 * 86400000);
    const expired = identityToken("viewer@example.test", -1);
    const renewed = identityToken("viewer@example.test");
    localStorage.setItem("soil_user", JSON.stringify({ email: "VIEWER@example.test", idToken: expired }));
    localStorage.setItem("soil_login_at", loginAt);
    let deliver: (response: { credential: string }) => void = () => {};
    vi.stubGlobal("google", { accounts: { id: {
      initialize: vi.fn((options) => { deliver = options.callback; }), prompt: vi.fn(),
    } } });
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    expect(auth.restoreSession()).toMatchObject({ email: "VIEWER@example.test", idToken: expired });
    const pending = auth.getValidIdToken(expired);
    deliver({ credential: renewed });
    expect(await pending).toBe(renewed);
    expect(localStorage.getItem("soil_login_at")).toBe(loginAt);
  });

  it("does not reuse or renew credentials after the session has been closed", async () => {
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const initialize = vi.fn();
    vi.stubGlobal("google", { accounts: { id: { initialize, prompt: vi.fn() } } });
    auth.signOut();
    await expect(auth.getValidIdToken(identityToken("viewer@example.test"))).rejects.toThrow("SIGN_IN_REQUIRED");
    await expect(auth.getValidIdToken(identityToken("viewer@example.test", -1))).rejects.toThrow("SIGN_IN_REQUIRED");
    expect(initialize).not.toHaveBeenCalled();
  });

  it("does not reuse an otherwise valid credential from a session older than 30 days", async () => {
    const token = identityToken("viewer@example.test");
    localStorage.setItem("soil_user", JSON.stringify({ email: "viewer@example.test", idToken: token }));
    localStorage.setItem("soil_login_at", String(Date.now() - 31 * 86400000));
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    await expect(auth.getValidIdToken(token)).rejects.toThrow("SIGN_IN_REQUIRED");
  });
});

describe("authentication storage failures", () => {
  it.each(["initial", "active"])("rejects a valid identity when storage reads fail during %s authentication", async (phase) => {
    const token = identityToken("viewer@example.test");
    localStorage.setItem("soil_user", JSON.stringify({ email: "viewer@example.test", idToken: token }));
    localStorage.setItem("soil_login_at", String(Date.now()));
    const blockReads = () => vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("synthetic blocked storage", "SecurityError");
    });
    if (phase === "initial") blockReads();
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    if (phase === "active") blockReads();
    await expect(auth.getValidIdToken(token)).rejects.toThrow("SIGN_IN_REQUIRED");
    expect(auth.restoreSession()).toBeNull();
  });

  it("does not authorize Sheets after an initial storage read failure until a fresh sign-in succeeds", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.test/proxy");
    const initialize = vi.fn(() => ({ requestAccessToken: vi.fn() }));
    let deliver: (response: { credential: string }) => void = () => {};
    vi.stubGlobal("google", { accounts: {
      id: { initialize: vi.fn((options) => { deliver = options.callback; }), prompt: vi.fn(), renderButton: vi.fn() },
      oauth2: { initTokenClient: initialize },
    } });
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("synthetic blocked storage", "SecurityError");
    });
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    read.mockRestore();
    const pending = auth.getAccessToken();
    auth.signOut();
    await expect(pending).rejects.toThrow("SIGN_IN_REQUIRED");
    expect(initialize).not.toHaveBeenCalled();
    const onUser = vi.fn();
    auth.renderSignInButton(document.createElement("div"), onUser);
    deliver({ credential: identityToken("viewer@example.test") });
    expect(onUser).toHaveBeenCalledTimes(1);
    expect(auth.restoreSession()?.email).toBe("viewer@example.test");
  });

  it("does not reset the login age when its stored timestamp cannot be read during sign-in", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.test/proxy");
    let deliver: (response: { credential: string }) => void = () => {};
    vi.stubGlobal("google", { accounts: { id: {
      initialize: vi.fn((options) => { deliver = options.callback; }), prompt: vi.fn(), renderButton: vi.fn(),
    } } });
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
      if (key === "soil_login_at") throw new DOMException("synthetic blocked storage", "SecurityError");
      return getItem.call(this, key);
    });
    const onUser = vi.fn();
    auth.renderSignInButton(document.createElement("div"), onUser);
    deliver({ credential: identityToken("viewer@example.test") });
    expect(onUser).not.toHaveBeenCalled();
    expect(auth.restoreSession()).toBeNull();
  });

  it("loads the sign-in helpers even when browser storage reads are blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("synthetic blocked storage", "SecurityError");
    });
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    expect(auth.restoreSession()).toBeNull();
  });

  it("does not throw while cleaning an unreadable session when removal is blocked", async () => {
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    localStorage.setItem("soil_user", "{broken");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("synthetic blocked removal", "SecurityError");
    });
    expect(auth.restoreSession()).toBeNull();
  });

  it.each(["soil_user", "soil_access_token", "soil_access_token_expiry", "soil_login_at"])(
    "finishes local sign-out even when removal fails for %s", async (failedKey) => {
      const user = { email: "viewer@example.test", idToken: identityToken("viewer@example.test") };
      const entries = {
        soil_user: JSON.stringify(user), soil_access_token: "synthetic-access",
        soil_access_token_expiry: String(Date.now() + 3600000), soil_login_at: String(Date.now()),
      };
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
      const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
      const disableAutoSelect = vi.fn();
      const revoke = vi.fn();
      vi.stubGlobal("google", { accounts: { id: { disableAutoSelect }, oauth2: { revoke } } });
      const originalRemove = Storage.prototype.removeItem;
      const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
        if (key === failedKey) throw new DOMException("synthetic blocked removal", "SecurityError");
        originalRemove.call(this, key);
      });
      expect(() => auth.signOut()).not.toThrow();
      for (const key of Object.keys(entries)) {
        expect(remove).toHaveBeenCalledWith(key);
        expect(localStorage.getItem(key)).toBe(key === failedKey ? entries[key as keyof typeof entries] : null);
      }
      expect(disableAutoSelect).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith("synthetic-access");
      expect(auth.restoreSession()).toBeNull();
    },
  );

  it("rejects identity renewal promptly when session persistence fails", async () => {
    vi.useFakeTimers();
    storeAuthSession(-1);
    let deliver: (response: { credential: string }) => void = () => {};
    vi.stubGlobal("google", { accounts: { id: {
      initialize: vi.fn((options) => { deliver = options.callback; }), prompt: vi.fn(),
    } } });
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("synthetic full storage", "QuotaExceededError");
    });
    const dispatch = vi.spyOn(window, "dispatchEvent");
    const resolved = vi.fn();
    const rejected = vi.fn();
    void auth.getValidIdToken(identityToken("viewer@example.test", -1)).then(resolved, rejected);
    deliver({ credential: identityToken("viewer@example.test") });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ name: "SignInRequiredError" }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: auth.SIGN_IN_REQUIRED_EVENT }));
    expect(auth.restoreSession()).toBeNull();
  });

  it("does not accept a new sign-in when session storage fails", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
    let deliver: (response: { credential: string }) => void = () => {};
    vi.stubGlobal("google", { accounts: { id: {
      initialize: vi.fn((options) => { deliver = options.callback; }), prompt: vi.fn(), renderButton: vi.fn(),
    } } });
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("synthetic full storage", "QuotaExceededError");
    });
    const dispatch = vi.spyOn(window, "dispatchEvent");
    const onUser = vi.fn();
    auth.renderSignInButton(document.createElement("div"), onUser);
    expect(() => deliver({ credential: identityToken("viewer@example.test") })).not.toThrow();
    expect(onUser).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: auth.SIGN_IN_REQUIRED_EVENT }));
    expect(auth.restoreSession()).toBeNull();
  });

  it("discards an access token if saving it fails instead of silently reusing it", async () => {
    storeAuthSession();
    let deliver: (response: { access_token: string; expires_in: number }) => void = () => {};
    const initialize = vi.fn((options) => {
      deliver = options.callback;
      return { requestAccessToken: vi.fn() };
    });
    vi.stubGlobal("google", { accounts: { oauth2: { initTokenClient: initialize } } });
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("synthetic full storage", "QuotaExceededError");
    });
    const first = expect(auth.getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
    deliver({ access_token: "synthetic-unsaved-access", expires_in: 3600 });
    await first;
    write.mockRestore();
    const second = expect(auth.getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
    expect(initialize).toHaveBeenCalledTimes(1);
    auth.signOut();
    await second;
  });

  it("allows a fresh sign-in after sign-out when storage works", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
    let deliver: (response: { credential: string }) => void = () => {};
    vi.stubGlobal("google", { accounts: { id: {
      initialize: vi.fn((options) => { deliver = options.callback; }),
      prompt: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn(),
    } } });
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    auth.signOut();
    expect(auth.restoreSession()).toBeNull();
    const onUser = vi.fn();
    auth.renderSignInButton(document.createElement("div"), onUser);
    const token = identityToken("viewer@example.test");
    deliver({ credential: token });
    expect(onUser).toHaveBeenCalledWith(expect.objectContaining({ email: "viewer@example.test", idToken: token }));
    expect(auth.restoreSession()).toMatchObject({ email: "viewer@example.test", idToken: token });
  });

  it("shows a storage warning after sign-out and clears it after successful sign-in", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
    let deliver: (response: { credential: string }) => void = () => {};
    vi.stubGlobal("google", { accounts: { id: {
      initialize: vi.fn((options) => { deliver = options.callback; }),
      prompt: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn(),
    } } });
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const { useApp } = await import("../store");
    const user = { email: "viewer@example.test", idToken: identityToken("viewer@example.test") };
    localStorage.setItem("soil_user", JSON.stringify(user));
    useApp.getState().setUser(user);
    const { default: LoginGate } = await import("../components/LoginGate");
    const view = render(createElement(LoginGate, { children: createElement("p", null, "synthetic-protected-screen") }));
    await waitFor(() => expect(view.getByText("synthetic-protected-screen")).toBeInTheDocument());
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("synthetic blocked removal", "SecurityError");
    });
    act(() => { auth.signOut(); useApp.getState().setUser(null); });
    expect(view.queryByText("synthetic-protected-screen")).not.toBeInTheDocument();
    expect(view.getByRole("alert")).toHaveTextContent("保存設定");
    remove.mockRestore();
    await act(async () => { deliver({ credential: identityToken("viewer@example.test") }); });
    expect(view.getByText("synthetic-protected-screen")).toBeInTheDocument();
    expect(view.queryByRole("alert")).not.toBeInTheDocument();
    act(() => { useApp.getState().setUser(null); });
    expect(view.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("account display-state isolation", () => {
  it("clears shared theme and selection on sign-out", async () => {
    const { useApp } = await import("../store");
    const { DEFAULT_THEME } = await import("../types");
    useApp.getState().setUser({ email: "viewer@example.test", idToken: "synthetic-token" });
    useApp.getState().setTheme({ ...DEFAULT_THEME, themeId: "synthetic-private-theme" });
    useApp.getState().setSelectedSource("synthetic-private-source");
    useApp.getState().setUser(null);
    expect(useApp.getState().theme).toEqual(DEFAULT_THEME);
    expect(useApp.getState().selectedSourceId).toBeNull();
  });

  it("resets shared display state when changing accounts", async () => {
    const { useApp } = await import("../store");
    const { DEFAULT_THEME } = await import("../types");
    useApp.getState().setUser({ email: "viewer@example.test", idToken: "synthetic-token" });
    useApp.getState().setTheme({ ...DEFAULT_THEME, themeId: "synthetic-private-theme" });
    useApp.getState().setSelectedSource("synthetic-private-source");
    useApp.getState().setUser({ email: "other@example.test", idToken: "synthetic-other-token" });
    expect(useApp.getState().theme).toEqual(DEFAULT_THEME);
    expect(useApp.getState().selectedSourceId).toBeNull();
  });

  it("preserves settings when refreshing the same account", async () => {
    const { useApp } = await import("../store");
    const { DEFAULT_THEME } = await import("../types");
    useApp.getState().setUser({ email: "viewer@example.test", idToken: "synthetic-token" });
    const theme = { ...DEFAULT_THEME, themeId: "synthetic-private-theme" };
    useApp.getState().setTheme(theme);
    useApp.getState().setSelectedSource("synthetic-private-source");
    useApp.getState().setUser({ email: "VIEWER@example.test", idToken: "synthetic-renewed-token" });
    expect(useApp.getState().theme).toEqual(theme);
    expect(useApp.getState().selectedSourceId).toBe("synthetic-private-source");
  });
});

describe("account-specific screen state", () => {
  it.each([
    ["other@example.test", "empty"],
    ["VIEWER@example.test", "synthetic-private-draft"],
  ])("isolates drafts while changing identity to %s", async (email, expected) => {
    function Draft() {
      const [value, setValue] = useState("empty");
      return createElement("button", { onClick: () => setValue("synthetic-private-draft") }, value);
    }
    const { useApp } = await import("../store");
    useApp.getState().setUser({ email: "viewer@example.test", idToken: "synthetic-token" });
    const { default: LoginGate } = await import("../components/LoginGate");
    const view = render(createElement(LoginGate, { children: createElement(Draft) }));
    await waitFor(() => expect(view.getByRole("button").textContent).toBe("empty"));
    fireEvent.click(view.getByRole("button"));
    expect(view.getByRole("button").textContent).toBe("synthetic-private-draft");
    act(() => { useApp.getState().setUser({ email, idToken: "synthetic-next-token" }); });
    expect(view.getByRole("button").textContent).toBe(expected);
  });
});

describe("late dashboard requests", () => {
  it.each([null, { email: "other@example.test", idToken: "synthetic-other-token" }])(
    "does not restore old account data after leaving the screen: %j", async (nextUser) => {
      const api = await import("../api/sheets");
      const { useApp } = await import("../store");
      const { DEFAULT_THEME } = await import("../types");
      let completeRegistry: (data: Awaited<ReturnType<typeof api.loadAllRegistry>>) => void = () => {};
      vi.spyOn(api, "loadAllRegistry").mockImplementation(() => new Promise((resolve) => { completeRegistry = resolve; }));
      vi.spyOn(api, "canAccessSource").mockResolvedValue(true);
      useApp.getState().setUser({ email: "viewer@example.test", idToken: "synthetic-token" });
      const { default: Dashboard } = await import("../components/Dashboard");
      const view = render(createElement(Dashboard));
      await waitFor(() => expect(api.loadAllRegistry).toHaveBeenCalled());
      view.unmount();
      useApp.getState().setUser(nextUser);
      await act(async () => {
        completeRegistry({
          sources: [source], users: [{ email: "viewer@example.test", role: "viewer", enabled: true }],
          acl: [{ email: "viewer@example.test", sourceId: source.sourceId, permission: "read" }],
          theme: { ...DEFAULT_THEME, themeId: "synthetic-private-theme" }, layouts: [],
        });
      });
      expect(useApp.getState().user).toEqual(nextUser);
      expect(useApp.getState().theme).toEqual(DEFAULT_THEME);
      expect(useApp.getState().selectedSourceId).toBeNull();
    },
  );

  it("does not retry a failed registry request after the screen closes", async () => {
    vi.useFakeTimers();
    const api = await import("../api/sheets");
    const { useApp } = await import("../store");
    vi.spyOn(api, "loadAllRegistry").mockRejectedValue(new Error("synthetic 429"));
    useApp.getState().setUser({ email: "viewer@example.test", idToken: "synthetic-token" });
    const { default: Dashboard } = await import("../components/Dashboard");
    const view = render(createElement(Dashboard));
    await act(async () => {});
    expect(api.loadAllRegistry).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.loadAllRegistry).toHaveBeenCalledTimes(1);
  });
});

describe("late admin saves", () => {
  it("preserves unsaved admin edits when only the same account's credentials change", async () => {
    const api = await import("../api/admin");
    const { useApp } = await import("../store");
    const { DEFAULT_THEME } = await import("../types");
    vi.spyOn(api, "adminGetSheet").mockImplementation(async (_token, sheet) => ({
      values: sheet === "theme" ? [["themeId", "json"], [DEFAULT_THEME.themeId, JSON.stringify(DEFAULT_THEME)]]
        : [["sourceId"], ["synthetic-original-source"]],
      revision: "synthetic-revision",
    }));
    useApp.getState().setUser({ email: "viewer@example.test", idToken: "synthetic-token" });
    const { default: AdminPanel } = await import("../components/AdminPanel");
    const view = render(createElement(AdminPanel));
    await waitFor(() => expect(view.getByDisplayValue("synthetic-original-source")).toBeEnabled());
    const themeInput = view.container.querySelector("textarea")!;
    await waitFor(() => expect(themeInput).toBeEnabled());
    fireEvent.change(view.getByDisplayValue("synthetic-original-source"), { target: { value: "synthetic-unsaved-source" } });
    fireEvent.change(themeInput, { target: { value: "synthetic-unsaved-theme" } });
    await act(async () => {
      useApp.getState().setUser({ email: "VIEWER@example.test", idToken: "synthetic-renewed-token" });
    });
    expect(view.getByDisplayValue("synthetic-unsaved-source")).toBeInTheDocument();
    expect(themeInput).toHaveValue("synthetic-unsaved-theme");
    expect(api.adminGetSheet).toHaveBeenCalledTimes(2);
  });

  it.each(["renewal", "signout"])("handles a pending theme save during %s", async (change) => {
    const api = await import("../api/admin");
    const { useApp } = await import("../store");
    const { DEFAULT_THEME } = await import("../types");
    const savedTheme = { ...DEFAULT_THEME, themeId: "synthetic-updated-theme" };
    vi.spyOn(api, "adminGetSheet").mockImplementation(async (_token, sheet) => ({
      values: sheet === "theme" ? [["themeId", "json"], [savedTheme.themeId, JSON.stringify(savedTheme)]] : [["sourceId"]],
      revision: "synthetic-revision",
    }));
    let completeSave: (revision: string) => void = () => {};
    vi.spyOn(api, "adminSaveTheme").mockImplementation(() => new Promise((resolve) => { completeSave = resolve; }));
    useApp.getState().setUser({ email: "viewer@example.test", idToken: "synthetic-token" });
    const { default: AdminPanel } = await import("../components/AdminPanel");
    const view = render(createElement(AdminPanel));
    const button = view.getByRole("button", { name: "テーマを保存" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    if (change === "signout") {
      view.unmount();
      useApp.getState().setUser(null);
    } else {
      act(() => { useApp.getState().setUser({ email: "viewer@example.test", idToken: "synthetic-renewed-token" }); });
    }
    await act(async () => { completeSave("synthetic-saved-revision"); });
    expect(useApp.getState().theme).toEqual(change === "signout" ? DEFAULT_THEME : savedTheme);
    if (change === "renewal") expect(button).toBeEnabled();
  });
});

describe("ID token renewal", () => {
  it("keeps an unexpired identity without contacting Google", async () => {
    const token = storeAuthSession();
    const { getValidIdToken } = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    expect(await getValidIdToken(token)).toBe(token);
  });

  it("renews expired identities once for concurrent requests", async () => {
    const expired = identityToken("viewer@example.test", -1);
    const renewed = identityToken("viewer@example.test");
    localStorage.setItem("soil_user", JSON.stringify({ email: "viewer@example.test", idToken: expired }));
    localStorage.setItem("soil_login_at", String(Date.now()));
    let deliver: (response: { credential: string }) => void = () => {};
    const prompt = vi.fn();
    vi.stubGlobal("google", { accounts: { id: {
      initialize: vi.fn((options) => { deliver = options.callback; }), prompt,
    } } });
    const { getValidIdToken } = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const first = getValidIdToken(expired);
    const second = getValidIdToken(expired);
    deliver({ credential: renewed });
    expect(await first).toBe(renewed);
    expect(await second).toBe(renewed);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(await getValidIdToken(expired)).toBe(renewed);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("rejects an identity from a different account", async () => {
    storeAuthSession(-1);
    const expired = identityToken("viewer@example.test", -1);
    vi.stubGlobal("google", { accounts: { id: {
      initialize: vi.fn((options) => { options.callback({ credential: identityToken("other@example.test") }); }),
      prompt: vi.fn(),
    } } });
    const { getValidIdToken } = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    await expect(getValidIdToken(expired)).rejects.toThrow("SIGN_IN_REQUIRED");
  });

  it("stops waiting when Google cannot renew a session", async () => {
    vi.useFakeTimers();
    storeAuthSession(-1);
    vi.stubGlobal("google", { accounts: { id: { initialize: vi.fn(), prompt: vi.fn() } } });
    const { getValidIdToken } = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const result = expect(getValidIdToken(identityToken("viewer@example.test", -1)))
      .rejects.toThrow("SIGN_IN_REQUIRED");
    await vi.advanceTimersByTimeAsync(15000);
    await result;
  });

  it("does not restore a session after the user signs out during renewal", async () => {
    storeAuthSession(-1);
    let deliver: (response: { credential: string }) => void = () => {};
    vi.stubGlobal("google", { accounts: { id: {
      initialize: vi.fn((options) => { deliver = options.callback; }), prompt: vi.fn(),
    } } });
    const { getValidIdToken, signOut } = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const result = expect(getValidIdToken(identityToken("viewer@example.test", -1)))
      .rejects.toThrow("SIGN_IN_REQUIRED");
    signOut();
    deliver({ credential: identityToken("viewer@example.test") });
    await result;
    expect(localStorage.getItem("soil_user")).toBeNull();
  });
});

describe("Sheets access-token lifecycle", () => {
  it("renews a token with a non-finite saved expiration instead of treating it as valid forever", async () => {
    storeAuthSession();
    localStorage.setItem("soil_access_token", "synthetic-old-access");
    localStorage.setItem("soil_access_token_expiry", "Infinity");
    const initialize = vi.fn(() => ({ requestAccessToken: vi.fn() }));
    vi.stubGlobal("google", { accounts: { oauth2: { initTokenClient: initialize } } });
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const pending = expect(auth.getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
    expect(initialize).toHaveBeenCalledTimes(1);
    auth.signOut();
    await pending;
  });

  it("rejects lifetimes that overflow the computed token expiration", async () => {
    storeAuthSession();
    let deliver: (response: { access_token: string; expires_in: number }) => void = () => {};
    vi.stubGlobal("google", { accounts: { oauth2: { initTokenClient: vi.fn((options) => {
      deliver = options.callback;
      return { requestAccessToken: vi.fn() };
    }) } } });
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const pending = expect(auth.getAccessToken()).rejects.toThrow("CONSENT_REQUIRED");
    deliver({ access_token: "synthetic-invalid-lifetime", expires_in: Number.MAX_VALUE });
    await pending;
    expect(localStorage.getItem("soil_access_token")).toBeNull();
    expect(localStorage.getItem("soil_access_token_expiry")).toBeNull();
  });

  it("keeps using a valid cached access token without opening Google authorization", async () => {
    storeAuthSession();
    localStorage.setItem("soil_access_token", "synthetic-cached-access");
    localStorage.setItem("soil_access_token_expiry", String(Date.now() + 3600000));
    const initialize = vi.fn();
    vi.stubGlobal("google", { accounts: { oauth2: { initTokenClient: initialize } } });
    const auth = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    expect(await auth.getAccessToken()).toBe("synthetic-cached-access");
    expect(initialize).not.toHaveBeenCalled();
  });

  it("does not persist a late access token after sign-out", async () => {
    storeAuthSession();
    let deliver: (response: { access_token: string; expires_in: number }) => void = () => {};
    vi.stubGlobal("google", { accounts: { oauth2: {
      initTokenClient: vi.fn((options) => {
        deliver = options.callback;
        return { requestAccessToken: vi.fn() };
      }),
    } } });
    const { getAccessToken, signOut } = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const result = expect(getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
    signOut();
    deliver({ access_token: "synthetic-late-access", expires_in: 3600 });
    await result;
    expect(localStorage.getItem("soil_access_token")).toBeNull();
    expect(localStorage.getItem("soil_access_token_expiry")).toBeNull();
  });

  it("shares one access-token request between simultaneous reads", async () => {
    storeAuthSession();
    let deliver: (response: { access_token: string; expires_in: number }) => void = () => {};
    const initialize = vi.fn((options) => {
      deliver = options.callback;
      return { requestAccessToken: vi.fn() };
    });
    vi.stubGlobal("google", { accounts: { oauth2: { initTokenClient: initialize } } });
    const { getAccessToken } = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const first = getAccessToken();
    const second = getAccessToken();
    expect(initialize).toHaveBeenCalledTimes(1);
    deliver({ access_token: "synthetic-shared-access", expires_in: 3600 });
    expect(await Promise.all([first, second])).toEqual(["synthetic-shared-access", "synthetic-shared-access"]);
  });

  it("does not request direct-Sheets permission for proxy-only sign-in", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
    const initializeAccess = vi.fn(() => ({ requestAccessToken: vi.fn() }));
    vi.stubGlobal("google", { accounts: {
      id: {
        initialize: vi.fn((options) => { options.callback({ credential: identityToken("viewer@example.test") }); }),
        prompt: vi.fn(), renderButton: vi.fn(),
      },
      oauth2: { initTokenClient: initializeAccess },
    } });
    const { renderSignInButton } = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    const onUser = vi.fn();
    renderSignInButton(document.createElement("div"), onUser);
    expect(onUser).toHaveBeenCalledTimes(1);
    expect(initializeAccess).not.toHaveBeenCalled();
  });

  it("allows a new request after an unresponsive provider times out", async () => {
    vi.useFakeTimers();
    storeAuthSession();
    const initialize = vi.fn(() => ({ requestAccessToken: vi.fn() }));
    vi.stubGlobal("google", { accounts: { oauth2: { initTokenClient: initialize } } });
    const { getAccessToken } = await vi.importActual<typeof import("../auth/google")>("../auth/google");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = expect(getAccessToken()).rejects.toThrow("CONSENT_REQUIRED");
      await vi.advanceTimersByTimeAsync(120000);
      await result;
    }
    expect(initialize).toHaveBeenCalledTimes(2);
  });
});

describe("protected API routing", () => {
  it("uses renewed credentials for protected requests", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
    vi.stubEnv("VITE_GAS_ADMIN_URL", "https://example.invalid/admin");
    const { getValidIdToken } = await import("../auth/google");
    vi.mocked(getValidIdToken).mockResolvedValueOnce("renewed-registry")
      .mockResolvedValueOnce("renewed-data").mockResolvedValueOnce("renewed-events")
      .mockResolvedValueOnce("renewed-tabs").mockResolvedValueOnce("renewed-admin");
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, revision: "initial", values: [] }) });
    vi.stubGlobal("fetch", fetch);
    const api = await import("../api/sheets");
    const { adminGetSheet } = await import("../api/admin");
    await api.loadAllRegistry("expired");
    await api.loadDataSource(source, "expired");
    await api.loadSourceEvents(source, "expired");
    await api.getSheetNames(source, "expired");
    await adminGetSheet("expired", "sources");
    expect(fetch.mock.calls.map(([, options]) => JSON.parse(options.body).idToken))
      .toEqual(["renewed-registry", "renewed-data", "renewed-events", "renewed-tabs", "renewed-admin"]);
  });

  it("does not send a request when renewal fails", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
    const { getValidIdToken } = await import("../auth/google");
    vi.mocked(getValidIdToken).mockRejectedValueOnce(new Error("SIGN_IN_REQUIRED"));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { loadAllRegistry } = await import("../api/sheets");
    await expect(loadAllRegistry("expired")).rejects.toThrow("SIGN_IN_REQUIRED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requests the filtered registry without first reading raw Sheets", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    const { loadAllRegistry } = await import("../api/sheets");
    await loadAllRegistry("synthetic-token");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://example.invalid/proxy");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ action: "registry", idToken: "synthetic-token" });
  });

  it("never falls back to direct Sheets after a proxy denial", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: "forbidden" }) });
    vi.stubGlobal("fetch", fetch);
    const { loadAllRegistry, loadDataSource } = await import("../api/sheets");
    await expect(loadAllRegistry("synthetic-token")).rejects.toThrow("forbidden");
    await expect(loadDataSource(source, "synthetic-token")).rejects.toThrow("forbidden");
    expect(fetch.mock.calls.every(([url]) => url === "https://example.invalid/proxy")).toBe(true);
  });

  it("routes legacy direct sources and tab discovery through the configured proxy", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.invalid/proxy");
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, values: [], names: ["sensor_raw"] }) });
    vi.stubGlobal("fetch", fetch);
    const { loadDataSource, getSheetNames } = await import("../api/sheets");
    await loadDataSource(source, "synthetic-token");
    expect(await getSheetNames(source, "synthetic-token")).toEqual(["sensor_raw"]);
    expect(fetch.mock.calls.every(([url]) => url === "https://example.invalid/proxy")).toBe(true);
    expect(JSON.parse(fetch.mock.calls[1][1].body).action).toBe("sheetNames");
  });

  it("refuses raw Mechatrax data when no proxy is configured", async () => {
    vi.stubEnv("VITE_GAS_PROXY_URL", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { loadDataSource } = await import("../api/sheets");
    await expect(loadDataSource(source)).rejects.toThrow("VITE_GAS_PROXY_URL");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("admin edit conflicts", () => {
  it("sends the loaded revision and returns the new revision", async () => {
    vi.stubEnv("VITE_GAS_ADMIN_URL", "https://example.invalid/admin");
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, values: [["key"]], revision: "initial" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, written: 1, revision: "updated" }) });
    vi.stubGlobal("fetch", fetch);
    const { adminGetSheet, adminPutRows } = await import("../api/admin");
    const snapshot = await adminGetSheet("synthetic-token", "sources");
    expect(await adminPutRows("synthetic-token", "sources", snapshot.values, snapshot.revision))
      .toEqual({ written: 1, revision: "updated" });
    expect(JSON.parse(fetch.mock.calls[1][1].body).expectedRevision).toBe("initial");
  });

  it("reports stale edits without silently retrying the overwrite", async () => {
    vi.stubEnv("VITE_GAS_ADMIN_URL", "https://example.invalid/admin");
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: "conflict" }) });
    vi.stubGlobal("fetch", fetch);
    const { adminPutRows } = await import("../api/admin");
    await expect(adminPutRows("synthetic-token", "sources", [["key"]], "stale"))
      .rejects.toThrow("保存されていません");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an outdated admin API that provides no revision", async () => {
    vi.stubEnv("VITE_GAS_ADMIN_URL", "https://example.invalid/admin");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, values: [] }) }));
    const { adminGetSheet } = await import("../api/admin");
    await expect(adminGetSheet("synthetic-token", "sources")).rejects.toThrow("管理APIの更新が必要");
  });
});

describe("admin lockout protection", () => {
  it("explains why duplicate user identities cannot be saved", async () => {
    vi.stubEnv("VITE_GAS_ADMIN_URL", "https://example.test/admin");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: "invalid_users" }) }));
    const { adminPutRows } = await import("../api/admin");
    await expect(adminPutRows("synthetic-token", "users", [], "initial"))
      .rejects.toThrow("メールアドレスが重複");
  });

  it("explains why removing the last administrator is refused", async () => {
    vi.stubEnv("VITE_GAS_ADMIN_URL", "https://example.invalid/admin");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: "admin_required" }) }));
    const { adminPutRows } = await import("../api/admin");
    await expect(adminPutRows("synthetic-token", "users", [], "initial"))
      .rejects.toThrow("有効な管理者を少なくとも1人");
  });
});

describe("CSV export", () => {
  it("quotes delimiters, quotes and newlines", () => {
    expect(toCsv([{ label: 'first,"second"\nthird', value: -5 }]))
      .toBe('label,value\r\n"first,""second""\nthird",-5');
  });

  it("neutralizes formula-like strings without changing negative numbers", () => {
    for (const value of ["=1+1", "+1+1", "-1+1", "@SUM(1)", "\t=1+1", "\r\n=1+1"]) {
      expect(toCsv([{ value }])).toContain("'" + value);
    }
    expect(toCsv([{ value: -5 }])).toBe("value\r\n-5");
  });
});
