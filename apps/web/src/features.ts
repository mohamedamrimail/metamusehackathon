import { useEffect, useState } from 'react';
import { api } from './api.ts';

/** GET /features: which optional integrations the server has, and the Meta key status (demo-mode banner). */
export interface Features {
  meta: { status: 'ok' | 'missing' | 'invalid' | 'unreachable'; message: string };
  demo: boolean;
  beta_approval: boolean;
  country_allowlist: boolean;
  whatsapp: boolean;
  glasses: boolean;
  email: boolean;
  google: boolean;
  microsoft: boolean;
  facebook: boolean;
  scenes: boolean;
  avatar_ai: boolean;
  /** DEMO: the Meta AI calls panel for demo accounts. */
  calls_panel: boolean;
}

let cached: Promise<Features | null> | undefined;
let loaded: Features | null = null;
export const loadFeatures = (): Promise<Features | null> => (cached ??= api<Features>('/features').then((f) => (loaded = f), () => null));
/** The features if already loaded (main.tsx loads them before the first render). */
export const getFeatures = (): Features | null => loaded;

/** The server's features, fetched once per page load; null until loaded (or if the call failed). */
export function useFeatures(): Features | null {
  const [f, setF] = useState<Features | null>(null);
  useEffect(() => { void loadFeatures().then(setF); }, []);
  return f;
}
