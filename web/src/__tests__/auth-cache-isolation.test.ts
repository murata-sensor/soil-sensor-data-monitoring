import { afterEach, describe, expect, it, vi } from "vitest";

function identityToken(email: string): string {
  return `synthetic.${btoa(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
}

function storeSession(email: string, accessToken: string): string {
  const raw = JSON.stringify({ email, idToken: identityToken(email) });
  localStorage.setItem("soil_user", raw);
  localStorage.setItem("soil_login_at", String(Date.now()));
  localStorage.setItem("soil_access_token", accessToken);
  localStorage.setItem("soil_access_token_expiry", String(Date.now() + 3600000));
  return raw;
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("OAuth cache isolation after explicit sign-in", () => {
  async function fixture() {
    vi.useFakeTimers();
    vi.stubEnv("VITE_GAS_PROXY_URL", "");
    let signIn: (response: { credential: string }) => void = () => {};
    let deliverAccess: (response: { access_token: string; expires_in: number }) => void = () => {};
    const revoke = vi.fn();
    const initializeAccess = vi.fn((options) => {
      deliverAccess = options.callback;
      return { requestAccessToken: vi.fn() };
    });
    vi.stubGlobal("google", { accounts: {
      id: {
        initialize: vi.fn((options) => { signIn = options.callback; }),
        prompt: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn(),
      },
      oauth2: { initTokenClient: initializeAccess, revoke },
    } });
    storeSession("viewer@example.test", "synthetic-viewer-access");
    const auth = await import("../auth/google");
    expect(auth.restoreSession()?.email).toBe("viewer@example.test");
    const other = storeSession("other@example.test", "synthetic-other-access");
    expect(auth.syncSessionFromStorage(new StorageEvent("storage", {
      key: "soil_user", newValue: other, storageArea: localStorage,
    }), "viewer@example.test")).toBe(true);
    expect(localStorage.getItem("soil_user")).toBe(other);
    expect(localStorage.getItem("soil_access_token")).toBe("synthetic-other-access");
    const onUser = vi.fn();
    auth.renderSignInButton(document.createElement("div"), onUser);
    return {
      auth, onUser, initializeAccess, revoke,
      signIn: () => signIn({ credential: identityToken("viewer@example.test") }),
      deliverAccess: () => deliverAccess({ access_token: "synthetic-new-access", expires_in: 3600 }),
    };
  }

  it("does not restore another account's OAuth cache after sign-in and a reload", async () => {
    const { auth, onUser, initializeAccess, revoke, signIn, deliverAccess } = await fixture();
    signIn();
    expect(onUser).toHaveBeenCalledWith(expect.objectContaining({ email: "viewer@example.test" }));

    // Reload while the OAuth request started by sign-in is still pending.
    vi.resetModules();
    const reloaded = await import("../auth/google");
    expect(reloaded.restoreSession()?.email).toBe("viewer@example.test");
    const token = reloaded.getAccessToken();
    expect(initializeAccess).toHaveBeenCalledTimes(2);
    deliverAccess();
    await expect(token).resolves.toBe("synthetic-new-access");
    expect(revoke).not.toHaveBeenCalled();
    auth.signOut();
  });

  it.each(["soil_access_token", "soil_access_token_expiry"])(
    "rejects sign-in if the old %s cache cannot be removed", async (blockedKey) => {
      const { auth, onUser, initializeAccess, revoke, signIn } = await fixture();
      const removeItem = Storage.prototype.removeItem;
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key: string) {
        if (key === blockedKey) throw new DOMException("synthetic blocked storage", "SecurityError");
        removeItem.call(this, key);
      });
      const storageWarning = vi.fn();
      window.addEventListener(auth.AUTH_STORAGE_FAILED_EVENT, storageWarning);
      try {
        signIn();
        expect(onUser).not.toHaveBeenCalled();
        expect(initializeAccess).not.toHaveBeenCalled();
        expect(auth.restoreSession()).toBeNull();
        expect(localStorage.getItem("soil_user")).toBeNull();
        await expect(auth.getAccessToken()).rejects.toThrow("SIGN_IN_REQUIRED");
        expect(storageWarning).toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener(auth.AUTH_STORAGE_FAILED_EVENT, storageWarning);
      }
    },
  );
});
