import { Fragment, useEffect, useRef, useState } from "react";
import { renderSignInButton, restoreSession, getAccessToken, getValidIdToken, signOut, syncSessionFromStorage, SIGN_IN_REQUIRED_EVENT, SESSION_CHANGED_EVENT, AUTH_STORAGE_FAILED_EVENT } from "../auth/google";
import { useApp } from "../store";

export default function LoginGate({ children }: { children: React.ReactNode }) {
  const user = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  const btnRef = useRef<HTMLDivElement>(null);
  const [restoring, setRestoring] = useState(true);
  const [expired, setExpired] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const [sessionChanged, setSessionChanged] = useState(false);
  const [signInVersion, setSignInVersion] = useState(0);

  useEffect(() => {
    let active = true;
    let remoteClosed = false;
    const requireSignIn = () => {
      active = false;
      if (!remoteClosed || useApp.getState().user) signOut();
      setUser(null);
      setExpired(true);
      setRestoring(false);
      setSignInVersion((version) => version + 1);
    };
    const reportStorageFailure = () => { setStorageFailed(true); };
    window.addEventListener(SIGN_IN_REQUIRED_EVENT, requireSignIn);
    window.addEventListener(AUTH_STORAGE_FAILED_EVENT, reportStorageFailure);
    const closeChangedSession = () => {
      remoteClosed = true;
      active = false;
      setUser(null);
      setSessionChanged(true);
      setRestoring(false);
      setSignInVersion((version) => version + 1);
    };
    window.addEventListener(SESSION_CHANGED_EVENT, closeChangedSession);
    const restored = useApp.getState().user || restoreSession();
    const syncSession = (event: StorageEvent) => {
      if (!syncSessionFromStorage(event, useApp.getState().user?.email ?? restored?.email)) return;
      closeChangedSession();
    };
    window.addEventListener("storage", syncSession);
    if (restored) {
      void getValidIdToken(restored.idToken).then((idToken) => {
        if (!active) return;
        setUser({ ...restored, idToken });
        if (!import.meta.env.VITE_GAS_PROXY_URL) void getAccessToken().catch(() => {});
      }).catch(() => {}).finally(() => { if (active) setRestoring(false); });
    } else {
      setRestoring(false);
    }
    return () => {
      active = false;
      window.removeEventListener(SIGN_IN_REQUIRED_EVENT, requireSignIn);
      window.removeEventListener(AUTH_STORAGE_FAILED_EVENT, reportStorageFailure);
      window.removeEventListener(SESSION_CHANGED_EVENT, closeChangedSession);
      window.removeEventListener("storage", syncSession);
    };
  }, [setUser]);

  useEffect(() => {
    if (user || restoring || !btnRef.current) return;
    return renderSignInButton(btnRef.current, (u) => { setExpired(false); setStorageFailed(false); setSessionChanged(false); setUser(u); });
  }, [user, restoring, setUser, signInVersion]);

  if (restoring) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-500 text-sm">読み込み中…</p>
      </div>
    );
  }

  if (user) return <Fragment key={user.email.trim().toLowerCase()}>{children}</Fragment>;
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="bg-white rounded-2xl shadow p-8 w-full max-w-[420px] text-center space-y-4">
        <h1 className="text-xl font-semibold">Soil Sensor Monitor</h1>
        {storageFailed
          ? <p role="alert" className="text-sm text-rose-700">端末内のログイン情報を扱えませんでした。ブラウザーの保存設定と空き容量を確認してください。共有端末では、このサイトの保存データを削除してから離れてください。</p>
          : sessionChanged
            ? <p role="alert" className="text-sm text-rose-700">別のタブでログイン状態が変わりました。もう一度ログインしてください。</p>
            : expired && <p role="alert" className="text-sm text-rose-700">ログインの有効期限が切れました。もう一度ログインしてください。</p>}
        <p className="text-sm text-slate-600">Google アカウントでサインインしてください。</p>
        <div ref={btnRef} className="flex justify-center" />
      </div>
    </div>
  );
}
