import { afterEach, describe, expect, it, vi } from "vitest";

const DAY = 86_400_000;

function identityToken(email = "viewer@example.test", seconds = 3600): string {
  return `synthetic.${btoa(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + seconds }))}.signature`;
}

function storeUser(email: string, idToken: string, loginAt = Date.now() - 7 * DAY): void {
  localStorage.setItem("soil_user", JSON.stringify({ email, idToken }));
  localStorage.setItem("soil_login_at", String(loginAt));
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Google prompts during sign-in and restoration", () => {
  async function fixture(saved = true, loaded = false, seconds = -1, loginAt = Date.now() - 7 * DAY) {
    vi.useFakeTimers();
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.test/proxy");
    const token = identityToken("viewer@example.test", seconds);
    if (saved) storeUser("viewer@example.test", token, loginAt);
    let deliver: (response: { credential: string }) => void = () => {};
    const initialize = vi.fn((options) => { deliver = options.callback; });
    const prompt = vi.fn();
    const disableAutoSelect = vi.fn();
    const sdk = { accounts: { id: {
      initialize, prompt, disableAutoSelect, renderButton: vi.fn(),
    } } };
    vi.stubGlobal("google", loaded ? sdk : undefined);
    const auth = await import("../auth/google");
    return {
      auth, token, initialize, prompt, disableAutoSelect,
      loadSdk: () => vi.stubGlobal("google", sdk),
      deliver: (credential = identityToken()) => deliver({ credential }),
    };
  }

  it("preserves Google automatic selection after a successful sign-in", async () => {
    const { auth, disableAutoSelect, deliver } = await fixture(false, true);
    const onUser = vi.fn();
    auth.renderSignInButton(document.createElement("div"), onUser);
    deliver();
    expect(onUser).toHaveBeenCalledTimes(1);
    expect(disableAutoSelect).not.toHaveBeenCalled();
    auth.signOut();
    expect(disableAutoSelect).toHaveBeenCalledTimes(1);
  });

  it("enables the FedCM button flow without preselecting an unverified local identity", async () => {
    const { auth, initialize, deliver } = await fixture(false, true);
    const onUser = vi.fn();
    auth.renderSignInButton(document.createElement("div"), onUser);
    expect(initialize.mock.calls[0][0]).toMatchObject({
      auto_select: true, use_fedcm_for_button: true, button_auto_select: true,
    });
    expect(initialize.mock.calls[0][0].login_hint).toBeUndefined();
    expect(onUser).not.toHaveBeenCalled();
    deliver();
    expect(onUser).toHaveBeenCalledTimes(1);
    expect(auth.restoreSession()?.email).toBe("viewer@example.test");
  });

  it.each(["sign-out", "account-change"])("keeps account selection after %s before the SDK loads", async (closure) => {
    const { auth, initialize, loadSdk, deliver } = await fixture(false);
    if (closure === "sign-out") auth.signOut();
    else {
      storeUser("other@example.test", identityToken("other@example.test"));
      auth.syncSessionFromStorage(new StorageEvent("storage", {
        key: "soil_user", newValue: localStorage.getItem("soil_user"), storageArea: localStorage,
      }), "viewer@example.test");
    }
    const onUser = vi.fn();
    auth.renderSignInButton(document.createElement("div"), onUser);
    loadSdk();
    await vi.advanceTimersByTimeAsync(200);
    expect(initialize.mock.calls[0][0]).toMatchObject({
      auto_select: false, use_fedcm_for_button: true, button_auto_select: false,
    });
    expect(initialize.mock.calls[0][0].login_hint).toBeUndefined();
    deliver();
    expect(onUser).toHaveBeenCalledTimes(1);
    expect(auth.restoreSession()?.email).toBe("viewer@example.test");
  });

  it("uses a valid cached identity immediately while the Google library is still loading", async () => {
    const { auth, token, initialize, prompt } = await fixture(true, false, 3600);
    const wait = vi.spyOn(window, "setTimeout");
    await expect(auth.getValidIdToken(token)).resolves.toBe(token);
    expect(initialize).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it("shares one renewal while waiting for Google and keeps the original login time", async () => {
    const { auth, token, loadSdk, initialize, prompt, deliver, disableAutoSelect } = await fixture();
    const loginAt = localStorage.getItem("soil_login_at");
    const first = auth.getValidIdToken(token).catch((error: unknown) => error);
    const second = auth.getValidIdToken(token).catch((error: unknown) => error);
    const renewed = identityToken();
    loadSdk();
    await vi.advanceTimersByTimeAsync(200);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(1);
    deliver(renewed);
    await expect(first).resolves.toBe(renewed);
    await expect(second).resolves.toBe(renewed);
    expect(localStorage.getItem("soil_login_at")).toBe(loginAt);
    expect(disableAutoSelect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("preserves a newer account when renewal times out with SDK loaded=%s", async (loaded) => {
    const { auth, token } = await fixture(true, loaded);
    const pending = auth.getValidIdToken(token).catch((error: unknown) => error);
    storeUser("other@example.test", identityToken("other@example.test"));
    const newer = { ...localStorage };
    const changed = vi.fn();
    window.addEventListener(auth.SESSION_CHANGED_EVENT, changed);
    try {
      await vi.advanceTimersByTimeAsync(15000);
      expect(await pending).toBeInstanceOf(auth.SignInRequiredError);
      expect(changed).toHaveBeenCalledTimes(1);
      expect({ ...localStorage }).toEqual(newer);
    } finally {
      window.removeEventListener(auth.SESSION_CHANGED_EVENT, changed);
    }
  });

  it("hints the current account during renewal while still rejecting a different account", async () => {
    const { auth, token, initialize, deliver } = await fixture(true, true);
    const pending = auth.getValidIdToken(token).catch((error: unknown) => error);
    deliver(identityToken("other@example.test"));
    expect(await pending).toBeInstanceOf(auth.SignInRequiredError);
    expect(initialize.mock.calls[0][0]).toMatchObject({ login_hint: "viewer@example.test" });
  });

  it("does not extend the 15-second renewal budget while loading the library", async () => {
    const { auth, token, loadSdk, initialize, prompt } = await fixture();
    const pending = auth.getValidIdToken(token).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(14000);
    loadSdk();
    await vi.advanceTimersByTimeAsync(200);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(800);
    expect(await pending).toBeInstanceOf(auth.SignInRequiredError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["sign-out", "storage-event", "delayed-storage-event"])(
    "stops the old SDK wait after %s without prompting for the old session", async (closure) => {
      const { auth, token, loadSdk, initialize, prompt } = await fixture();
      const pending = expect(auth.getValidIdToken(token)).rejects.toThrow("SIGN_IN_REQUIRED");
      if (closure === "sign-out") auth.signOut();
      else {
        storeUser("other@example.test", identityToken("other@example.test"));
        if (closure === "storage-event") auth.syncSessionFromStorage(new StorageEvent("storage", {
          key: "soil_user", newValue: localStorage.getItem("soil_user"), storageArea: localStorage,
        }), "viewer@example.test");
      }
      const newer = { ...localStorage };
      loadSdk();
      await vi.advanceTimersByTimeAsync(200);
      await pending;
      expect(initialize).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
      expect({ ...localStorage }).toEqual(newer);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rechecks the 30-day limit before requesting Google after the library loads", async () => {
    const { auth, token, loadSdk, initialize, prompt } = await fixture(true, false, -1, Date.now() - 30 * DAY + 100);
    const pending = expect(auth.getValidIdToken(token)).rejects.toThrow("SIGN_IN_REQUIRED");
    loadSdk();
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(initialize).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(localStorage.getItem("soil_user")).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops before prompting if session storage becomes unreadable during the SDK wait", async () => {
    const { auth, token, loadSdk, initialize, prompt } = await fixture();
    const pending = expect(auth.getValidIdToken(token)).rejects.toThrow("SIGN_IN_REQUIRED");
    const saved = { ...localStorage };
    const blockedRead = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("synthetic blocked storage", "SecurityError");
    });
    loadSdk();
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    blockedRead.mockRestore();
    expect(initialize).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect({ ...localStorage }).toEqual(saved);
    expect(auth.restoreSession()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
