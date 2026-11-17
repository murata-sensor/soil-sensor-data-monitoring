import { afterEach, describe, expect, it, vi } from "vitest";

function identityToken(email: string, seconds = 3600): string {
  return `synthetic.${btoa(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + seconds }))}.signature`;
}

function storeOtherSession(): void {
  localStorage.setItem("soil_user", JSON.stringify({ email: "other@example.test", idToken: identityToken("other@example.test") }));
  localStorage.setItem("soil_login_at", String(Date.now()));
  localStorage.setItem("soil_access_token", "synthetic-other-access");
  localStorage.setItem("soil_access_token_expiry", String(Date.now() + 3600000));
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("sign-in responses before cross-tab notifications arrive", () => {
  async function fixture() {
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.test/proxy");
    let deliver: (response: { credential: string }) => void = () => {};
    const revoke = vi.fn();
    vi.stubGlobal("google", { accounts: {
      id: {
        initialize: vi.fn((options) => { deliver = options.callback; }),
        prompt: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn(),
      },
      oauth2: { revoke },
    } });
    const auth = await import("../auth/google");
    const onUser = vi.fn();
    return {
      auth, onUser, revoke,
      render: () => auth.renderSignInButton(document.createElement("div"), onUser),
      deliver: (credential = identityToken("viewer@example.test")) => deliver({ credential }),
    };
  }

  it.each(["valid", "malformed", "expired"])(
    "rejects an old %s response without changing the newer account", async (kind) => {
      const { auth, onUser, revoke, render, deliver } = await fixture();
      render();
      storeOtherSession();
      const newer = { ...localStorage };
      const changed = vi.fn();
      window.addEventListener(auth.SESSION_CHANGED_EVENT, changed);
      try {
        // A real storage event is deliberately absent until after this callback.
        deliver(kind === "malformed" ? "broken" : identityToken("viewer@example.test", kind === "expired" ? -1 : 3600));
        expect(onUser).not.toHaveBeenCalled();
        expect({ ...localStorage }).toEqual(newer);
        expect(auth.restoreSession()).toBeNull();
        expect(changed).toHaveBeenCalledTimes(1);
        expect(revoke).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener(auth.SESSION_CHANGED_EVENT, changed);
      }
    },
  );

  it("does not restore a session after another tab logs out before notification", async () => {
    const { auth, onUser, revoke, render, deliver } = await fixture();
    storeOtherSession();
    // The receiving tab is already at its login screen after an earlier change.
    auth.syncSessionFromStorage(new StorageEvent("storage", {
      key: "soil_user", newValue: localStorage.getItem("soil_user"), storageArea: localStorage,
    }), "viewer@example.test");
    render();
    localStorage.clear();
    deliver();
    expect(onUser).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(auth.restoreSession()).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each(["soil_user", "soil_login_at"])(
    "rejects the response and reports unreadable %s without deleting another account", async (key) => {
      const { auth, onUser, revoke, render, deliver } = await fixture();
      render();
      storeOtherSession();
      const newer = { ...localStorage };
      const read = Storage.prototype.getItem;
      const blockedRead = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, item) {
        if (item === key) throw new DOMException("synthetic blocked storage", "SecurityError");
        return read.call(this, item);
      });
      const warning = vi.fn();
      window.addEventListener(auth.AUTH_STORAGE_FAILED_EVENT, warning);
      try {
        deliver();
        blockedRead.mockRestore();
        expect(onUser).not.toHaveBeenCalled();
        expect({ ...localStorage }).toEqual(newer);
        expect(auth.restoreSession()).toBeNull();
        expect(warning).toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener(auth.AUTH_STORAGE_FAILED_EVENT, warning);
      }
    },
  );

  it("requires a new button if its original stored session could not be read", async () => {
    const { auth, onUser, render, deliver } = await fixture();
    const warning = vi.fn();
    window.addEventListener(auth.AUTH_STORAGE_FAILED_EVENT, warning);
    try {
      const blockedRead = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new DOMException("synthetic blocked storage", "SecurityError");
      });
      render();
      blockedRead.mockRestore();
      deliver();
      expect(onUser).not.toHaveBeenCalled();
      expect(auth.restoreSession()).toBeNull();
      expect(warning).toHaveBeenCalled();
      render();
      deliver();
      expect(onUser).toHaveBeenCalledTimes(1);
      expect(auth.restoreSession()?.email).toBe("viewer@example.test");
    } finally {
      window.removeEventListener(auth.AUTH_STORAGE_FAILED_EVENT, warning);
    }
  });
});

describe("OAuth cache ownership before the first session restore", () => {
  async function fixture() {
    const idToken = identityToken("viewer@example.test");
    const loginAt = String(Date.now() - 1000);
    localStorage.setItem("soil_user", JSON.stringify({ email: "viewer@example.test", idToken }));
    localStorage.setItem("soil_login_at", loginAt);
    localStorage.setItem("soil_access_token", "synthetic-viewer-access");
    localStorage.setItem("soil_access_token_expiry", String(Date.now() + 3600000));
    const revoke = vi.fn();
    vi.stubGlobal("google", { accounts: {
      id: { disableAutoSelect: vi.fn() }, oauth2: { revoke },
    } });
    const auth = await import("../auth/google");
    return { auth, revoke, idToken, loginAt };
  }

  it.each(["account", "login-time"])("rejects a cache if the stored %s changes before the first restore", async (kind) => {
    const { auth, revoke } = await fixture();
    if (kind === "account") storeOtherSession();
    else localStorage.setItem("soil_login_at", String(Date.now()));
    const newer = { ...localStorage };
    const changed = vi.fn();
    window.addEventListener(auth.SESSION_CHANGED_EVENT, changed);
    try {
      expect(auth.restoreSession()).toBeNull();
      await expect(auth.getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
      expect({ ...localStorage }).toEqual(newer);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(auth.SESSION_CHANGED_EVENT, changed);
    }
  });

  it("keeps a cached token when the stored identity and login time are unchanged", async () => {
    const { auth, idToken, loginAt } = await fixture();
    expect(auth.restoreSession()).toEqual({ email: "viewer@example.test", idToken });
    await expect(auth.getAccessToken()).resolves.toBe("synthetic-viewer-access");
    expect(localStorage.getItem("soil_login_at")).toBe(loginAt);
  });

  it("accepts another tab's identity renewal for the same account and original login time", async () => {
    const { auth, loginAt, revoke } = await fixture();
    const renewed = identityToken("VIEWER@example.test", 7200);
    localStorage.setItem("soil_user", JSON.stringify({ email: "VIEWER@example.test", idToken: renewed }));
    expect(auth.restoreSession()?.idToken).toBe(renewed);
    await expect(auth.getAccessToken()).resolves.toBe("synthetic-viewer-access");
    expect(localStorage.getItem("soil_login_at")).toBe(loginAt);
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each(["soil_user", "soil_login_at"])("stays closed if the initial %s snapshot could not be read", async (key) => {
    const read = Storage.prototype.getItem;
    const blockedRead = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, item) {
      if (item === key) throw new DOMException("synthetic blocked storage", "SecurityError");
      return read.call(this, item);
    });
    const { auth, revoke } = await fixture();
    blockedRead.mockRestore();
    const saved = { ...localStorage };
    const warning = vi.fn();
    window.addEventListener(auth.AUTH_STORAGE_FAILED_EVENT, warning);
    try {
      expect(auth.restoreSession()).toBeNull();
      await expect(auth.getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
      expect({ ...localStorage }).toEqual(saved);
      expect(warning).toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(auth.AUTH_STORAGE_FAILED_EVENT, warning);
    }
  });

  it.each(["soil_user", "soil_login_at"])("preserves shared storage if %s cannot be read during the first restore", async (key) => {
    const { auth, revoke } = await fixture();
    storeOtherSession();
    const newer = { ...localStorage };
    const read = Storage.prototype.getItem;
    const blockedRead = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, item) {
      if (item === key) throw new DOMException("synthetic blocked storage", "SecurityError");
      return read.call(this, item);
    });
    const warning = vi.fn();
    window.addEventListener(auth.AUTH_STORAGE_FAILED_EVENT, warning);
    try {
      expect(auth.restoreSession()).toBeNull();
      blockedRead.mockRestore();
      expect({ ...localStorage }).toEqual(newer);
      expect(auth.restoreSession()).toBeNull();
      expect(warning).toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(auth.AUTH_STORAGE_FAILED_EVENT, warning);
    }
  });
});
