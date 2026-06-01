import { create } from "zustand";
import { DEFAULT_THEME, type SourceRow, type Theme } from "./types";
import type { SignedInUser } from "./auth/google";

interface State {
  user: SignedInUser | null;
  theme: Theme;
  selectedSourceId: string | null;
  setUser: (u: SignedInUser | null) => void;
  setTheme: (t: Theme) => void;
  setSelectedSource: (s: SourceRow | string | null) => void;
}

export const useApp = create<State>((set) => ({
  user: null,
  theme: DEFAULT_THEME,
  selectedSourceId: null,
  setUser: (user) => set({ user }),
  setTheme: (theme) => set({ theme }),
  setSelectedSource: (s) =>
    set({ selectedSourceId: s === null ? null : typeof s === "string" ? s : s.sourceId }),
}));
