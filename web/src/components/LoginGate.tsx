import { useEffect, useRef } from "react";
import { renderSignInButton, restoreSession } from "../auth/google";
import { useApp } from "../store";

export default function LoginGate({ children }: { children: React.ReactNode }) {
  const user = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  const btnRef = useRef<HTMLDivElement>(null);

  // Restore persisted session on mount.
  useEffect(() => {
    if (!user) {
      const restored = restoreSession();
      if (restored) setUser(restored);
    }
  }, []);

  useEffect(() => {
    if (user || !btnRef.current) return;
    renderSignInButton(btnRef.current, (u) => setUser(u));
  }, [user, setUser]);

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
