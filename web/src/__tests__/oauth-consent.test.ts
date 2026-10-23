import { afterEach, describe, expect, it, vi } from "vitest";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Sheets authorization without forced consent", () => {
  async function fixture(cacheLifetime?: number, loaded = true) {
    vi.useFakeTimers();
    vi.stubEnv("VITE_GAS_PROXY_URL", "");
    const email = "VIEWER@example.test";
    const idToken = `synthetic.${btoa(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
    localStorage.setItem("soil_user", JSON.stringify({ email, idToken }));
    localStorage.setItem("soil_login_at", String(Date.now() - 7 * 86_400_000));
    if (cacheLifetime !== undefined) {
      localStorage.setItem("soil_access_token", "synthetic-cached-access");
      localStorage.setItem("soil_access_token_expiry", String(Date.now() + cacheLifetime));
    }
    let callback: (response: { access_token: string; expires_in: number }) => void = () => {};
    const requestAccessToken = vi.fn();
    const initialize = vi.fn((options) => {
      callback = options.callback;
      return { requestAccessToken };
    });
    vi.stubGlobal("google", loaded ? { accounts: { oauth2: { initTokenClient: initialize } } } : undefined);
    const auth = await import("../auth/google");
    return {
      auth, initialize, requestAccessToken,
      deliver: (accessToken = "synthetic-new-access", lifetime = 3600) => callback({ access_token: accessToken, expires_in: lifetime }),
    };
  }

  it("reuses a valid access token instead of asking Google to authorize again", async () => {
    const { auth, initialize, requestAccessToken, deliver } = await fixture(3600000);
    const pending = auth.requestConsentToken();
    deliver();
    await expect(pending).resolves.toBe("synthetic-cached-access");
    expect(initialize).not.toHaveBeenCalled();
    expect(requestAccessToken).not.toHaveBeenCalled();
  });

  it("can reuse a valid token before the Google library is loaded", async () => {
    const { auth, initialize } = await fixture(3600000, false);
    await expect(auth.requestConsentToken()).resolves.toBe("synthetic-cached-access");
    expect(initialize).not.toHaveBeenCalled();
  });

  it.each([undefined, -1, 59000])("requests required access with cache lifetime %s without forcing consent", async (cacheLifetime) => {
    const { auth, initialize, requestAccessToken, deliver } = await fixture(cacheLifetime);
    const pending = auth.requestConsentToken();
    deliver();
    await expect(pending).resolves.toBe("synthetic-new-access");
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      scope: SCOPE, login_hint: "viewer@example.test",
    }));
    expect(requestAccessToken).toHaveBeenCalledExactlyOnceWith({ prompt: "" });
  });

  it("shares an in-progress request and reuses its successful grant on the next click", async () => {
    const { auth, initialize, requestAccessToken, deliver } = await fixture();
    const pending = [auth.getAccessToken(), auth.requestConsentToken(), auth.requestConsentToken()];
    deliver();
    await expect(Promise.all(pending)).resolves.toEqual([
      "synthetic-new-access", "synthetic-new-access", "synthetic-new-access",
    ]);
    const nextClick = auth.requestConsentToken();
    deliver();
    await expect(nextClick).resolves.toBe("synthetic-new-access");
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(requestAccessToken).toHaveBeenCalledTimes(1);
  });

  it("still rejects an unsuccessful first grant instead of inventing access", async () => {
    const { auth, requestAccessToken, deliver } = await fixture();
    const pending = expect(auth.requestConsentToken()).rejects.toThrow("CONSENT_REQUIRED");
    deliver("", 0);
    await pending;
    expect(requestAccessToken).toHaveBeenCalledExactlyOnceWith({ prompt: "" });
    expect(localStorage.getItem("soil_access_token")).toBeNull();
  });
});
