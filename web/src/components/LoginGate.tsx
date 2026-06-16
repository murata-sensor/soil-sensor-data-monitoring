import { useEffect, useRef, useState } from "react";
import { renderSignInButton, restoreSession, getAccessToken, isIdTokenExpired, refreshIdToken } from "../auth/google";
import { useApp } from "../store";

export default function LoginGate({ children }: { children: React.ReactNode }) {
  const user = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  const btnRef = useRef<HTMLDivElement>(null);
  const [restoring, setRestoring] = useState(true);

  // Restore persisted session on mount and silently refresh token.
  useEffect(() => {
    if (!user) {
      const restored = restoreSession();
      if (restored) {
        setUser(restored);
        // If ID token is expired, silently refresh via One Tap
        if (isIdTokenExpired(restored)) {
          refreshIdToken((u) => setUser(u));
        }
        // Pre-warm the access token silently
        getAccessToken().catch(() => { /* handled later by Dashboard */ });
      }
    }
    setRestoring(false);
  }, []);

  useEffect(() => {
    if (user || restoring || !btnRef.current) return;
    renderSignInButton(btnRef.current, (u) => setUser(u));
  }, [user, restoring, setUser]);

  if (restoring) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-500 text-sm">読み込み中…</p>
      </div>
    );
  }

  if (user) return <>{children}</>;
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="bg-white rounded-2xl shadow p-8 w-[420px] text-center space-y-4">
        <h1 className="text-xl font-semibold">Soil Sensor Monitor</h1>
        <p className="text-sm text-slate-600">Google アカウントでサインインしてください。</p>
        <div ref={btnRef} className="flex justify-center" />
      </div>
    </div>
  );
}
