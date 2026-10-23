import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";

function identityToken(email: string, seconds: number): string {
  return `synthetic.${btoa(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + seconds }))}.signature`;
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

describe("session restoration while Google Identity Services loads", () => {
  async function fixture(strictMode = false, seconds = -1) {
    vi.useFakeTimers();
    vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.test/proxy");
    vi.stubGlobal("google", undefined);
    const token = identityToken("viewer@example.test", seconds);
    localStorage.setItem("soil_user", JSON.stringify({ email: "viewer@example.test", idToken: token }));
    localStorage.setItem("soil_login_at", String(Date.now() - 1000));
    const saved = { ...localStorage };
    let deliver: (response: { credential: string }) => void = () => {};
    const initialize = vi.fn((options) => { deliver = options.callback; });
    const prompt = vi.fn();
    const renderButton = vi.fn();
    const initializeAccess = vi.fn();
    const sdk = { accounts: {
      id: { initialize, prompt, renderButton, disableAutoSelect: vi.fn() },
      oauth2: { initTokenClient: initializeAccess, revoke: vi.fn() },
    } };
    const auth = await import("../auth/google");
    const { useApp } = await import("../store");
    const { default: LoginGate } = await import("../components/LoginGate");
    const gate = <LoginGate><p>synthetic-private-screen</p></LoginGate>;
    const view = render(strictMode ? <StrictMode>{gate}</StrictMode> : gate);
    return {
      auth, useApp, view, saved, initialize, prompt, renderButton, initializeAccess, sdk,
      deliver: () => deliver({ credential: identityToken("viewer@example.test", 3600) }),
    };
  }

  it("restores a valid saved identity without Google prompts or OAuth requests", async () => {
    const { view, saved, initialize, prompt, renderButton, initializeAccess, useApp } = await fixture(false, 3600);
    await act(async () => {});
    expect(view.getByText("synthetic-private-screen")).toBeInTheDocument();
    expect(useApp.getState().user?.email).toBe("viewer@example.test");
    expect({ ...localStorage }).toEqual(saved);
    expect(initialize).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(renderButton).not.toHaveBeenCalled();
    expect(initializeAccess).not.toHaveBeenCalled();
  });

  it.each([false, true])("restores an expired identity after SDK loading with one prompt (StrictMode=%s)", async (strictMode) => {
    const { view, saved, initialize, prompt, renderButton, initializeAccess, sdk, deliver, useApp } = await fixture(strictMode);
    expect(view.getByText("読み込み中…")).toBeInTheDocument();
    expect({ ...localStorage }).toEqual(saved);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    vi.stubGlobal("google", sdk);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(renderButton).not.toHaveBeenCalled();
    await act(async () => { deliver(); });
    expect(view.getByText("synthetic-private-screen")).toBeInTheDocument();
    expect(useApp.getState().user?.email).toBe("viewer@example.test");
    expect(localStorage.getItem("soil_login_at")).toBe(saved.soil_login_at);
    expect(initializeAccess).not.toHaveBeenCalled();
  });

  it.each(["sign-out", "other-tab"])("does not resume the old restoration after %s while waiting for the SDK", async (closure) => {
    const { auth, view, initialize, prompt, renderButton, initializeAccess, sdk, useApp } = await fixture();
    expect(view.getByText("読み込み中…")).toBeInTheDocument();
    await act(async () => {
      if (closure === "sign-out") {
        auth.signOut();
        window.dispatchEvent(new Event(auth.SIGN_IN_REQUIRED_EVENT));
      } else {
        const user = JSON.stringify({ email: "other@example.test", idToken: identityToken("other@example.test", 3600) });
        localStorage.setItem("soil_user", user);
        localStorage.setItem("soil_login_at", String(Date.now()));
        localStorage.setItem("soil_access_token", "synthetic-other-access");
        localStorage.setItem("soil_access_token_expiry", String(Date.now() + 3600000));
        window.dispatchEvent(new StorageEvent("storage", { key: "soil_user", newValue: user, storageArea: localStorage }));
      }
    });
    const saved = { ...localStorage };
    vi.stubGlobal("google", sdk);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    // Only the new login screen may initialize GIS; the old renewal must stop.
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(view.queryByText("synthetic-private-screen")).not.toBeInTheDocument();
    expect(useApp.getState().user).toBeNull();
    expect(auth.restoreSession()).toBeNull();
    expect({ ...localStorage }).toEqual(saved);
    expect(initializeAccess).not.toHaveBeenCalled();
    expect(sdk.accounts.oauth2.revoke).not.toHaveBeenCalled();
  });

  it("preserves another account when the SDK wait times out before its storage notification arrives", async () => {
    const { auth, view, initialize, prompt, renderButton, sdk, useApp } = await fixture();
    expect(view.getByText("読み込み中…")).toBeInTheDocument();
    const user = JSON.stringify({ email: "other@example.test", idToken: identityToken("other@example.test", 3600) });
    localStorage.setItem("soil_user", user);
    localStorage.setItem("soil_login_at", String(Date.now()));
    localStorage.setItem("soil_access_token", "synthetic-other-access");
    localStorage.setItem("soil_access_token_expiry", String(Date.now() + 3600000));
    const saved = { ...localStorage };
    // Neither the SDK nor the cross-tab notification arrives before the deadline.
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect({ ...localStorage }).toEqual(saved);
    expect(useApp.getState().user).toBeNull();
    expect(auth.restoreSession()).toBeNull();
    expect(view.queryByText("synthetic-private-screen")).not.toBeInTheDocument();
    expect(view.getByRole("alert")).toHaveTextContent("別のタブ");
    expect(initialize).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(renderButton).not.toHaveBeenCalled();
    expect(sdk.accounts.oauth2.revoke).not.toHaveBeenCalled();
  });
});
