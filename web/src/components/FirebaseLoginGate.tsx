import { Fragment, useEffect, useState } from "react";
import {
  FIREBASE_AUTH_ERROR_EVENT, firebaseErrorMessage, signInFirebase, subscribeFirebaseSession,
} from "../auth/firebase";
import { SIGN_IN_REQUIRED_EVENT } from "../auth/google";
import { useApp } from "../store";

export default function FirebaseLoginGate({ children }: { children: React.ReactNode }) {
  const user = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  const [restoring, setRestoring] = useState(true);
  const [rememberDevice, setRememberDevice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const failed = (cause: unknown) => {
      setUser(null);
      setRestoring(false);
      setError(firebaseErrorMessage(cause));
    };
    const reportError = () => {
      setUser(null);
      setRestoring(false);
      setError("ログアウト処理を完了できませんでした。ブラウザーの保存設定を確認してください。共有端末では、このサイトの保存データを削除してから離れてください。");
    };
    const requireSignIn = () => {
      setUser(null);
      setRestoring(false);
      setError("ログイン状態が終了しました。もう一度ログインしてください。");
    };
    window.addEventListener(FIREBASE_AUTH_ERROR_EVENT, reportError);
    window.addEventListener(SIGN_IN_REQUIRED_EVENT, requireSignIn);
    const unsubscribe = subscribeFirebaseSession((nextUser) => {
      setUser(nextUser);
      setRestoring(false);
      if (nextUser) setError("");
      else setRememberDevice(false);
    }, failed);
    return () => {
      unsubscribe();
      window.removeEventListener(FIREBASE_AUTH_ERROR_EVENT, reportError);
      window.removeEventListener(SIGN_IN_REQUIRED_EVENT, requireSignIn);
    };
  }, [setUser]);

  const login = async () => {
    setBusy(true);
    setError("");
    try {
      await signInFirebase(rememberDevice);
    } catch (cause) {
      setError(firebaseErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (restoring) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">読み込み中…</p></div>;
  }
  if (user) return <Fragment key={user.email.trim().toLowerCase()}>{children}</Fragment>;
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="bg-white rounded-2xl shadow p-8 w-full max-w-[420px] text-center space-y-4">
        <h1 className="text-xl font-semibold">Soil Sensor Monitor</h1>
        {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
        <p className="text-sm text-slate-600">Google アカウントでサインインしてください。</p>
        <label className="flex items-center justify-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={rememberDevice} disabled={busy}
            onChange={(event) => setRememberDevice(event.target.checked)} aria-describedby="remember-device-help" />
          この端末にログイン状態を保存する
        </label>
        <p id="remember-device-help" className="text-xs text-slate-500">
          共有端末ではチェックしないでください。未チェックの場合は、このタブを閉じるまで保持します。利用後はログアウトしてください。
        </p>
        <button type="button" disabled={busy} onClick={() => { void login(); }}
          className="px-4 py-2 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-50">
          {busy ? "ログイン中…" : "Googleでログイン"}
        </button>
      </div>
    </div>
  );
}
