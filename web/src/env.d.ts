/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID: string;
  readonly VITE_REGISTRY_SPREADSHEET_ID: string;
  readonly VITE_GAS_ADMIN_URL?: string;
  readonly VITE_GAS_PROXY_URL?: string;
  readonly VITE_BASE_PATH?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }

// Google Identity Services typings (minimum subset)
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: {
            client_id: string;
            scope: string;
            callback: (resp: { access_token: string; expires_in: number }) => void;
          }) => { requestAccessToken: (opts?: { prompt?: string }) => void };
        };
        id: {
          initialize: (cfg: {
            client_id: string;
            callback: (resp: { credential: string }) => void;
          }) => void;
          prompt: () => void;
          renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
        };
      };
    };
  }
}
export {};
