import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("does not restore a resolved identity after sign-in becomes required", async () => {
  vi.stubEnv("VITE_GAS_PROXY_URL", "https://example.test/proxy");
  const idToken = `synthetic.${btoa(JSON.stringify({
    email: "viewer@example.test", exp: Math.floor(Date.now() / 1000) + 3600,
  }))}.signature`;
  localStorage.setItem("soil_user", JSON.stringify({ email: "viewer@example.test", idToken }));
  localStorage.setItem("soil_login_at", String(Date.now()));
  vi.stubGlobal("google", { accounts: { id: {
    initialize: vi.fn(), prompt: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn(),
  } } });
  const auth = await import("../auth/google");
  const { useApp } = await import("../store");
  const { default: LoginGate } = await import("../components/LoginGate");
  const view = render(<LoginGate><p>synthetic-private-screen</p></LoginGate>);

  // The valid cached token has resolved, but restoration has not run its then callback yet.
  act(() => { window.dispatchEvent(new Event(auth.SIGN_IN_REQUIRED_EVENT)); });
  await act(async () => {});

  expect(useApp.getState().user).toBeNull();
  expect(view.queryByText("synthetic-private-screen")).not.toBeInTheDocument();
  expect(view.getByRole("alert")).toHaveTextContent("もう一度ログインしてください");
  expect(localStorage.getItem("soil_user")).toBeNull();
  expect(auth.restoreSession()).toBeNull();
});
