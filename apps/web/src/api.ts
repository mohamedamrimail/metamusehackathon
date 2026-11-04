// Thin fetch wrapper for the server's REST API (served under /api by nginx and the Vite proxy).

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body || init.form ? 'POST' : 'GET'),
    credentials: 'include',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? data.error);
  return data as T;
}

export interface User { id: string; email: string; name: string; locale: string; timezone: string; phone: string | null; ai_credit_usd?: number;
  gender?: string | null; age_range?: string | null; consent_required?: boolean; selfie_consent?: boolean; verified?: boolean;
  country?: string | null; currency?: string | null; setup_step?: string | null; onboarded?: boolean; has_password?: boolean;
  /** 'user' | 'judge' | 'demo' */
  account_kind?: string;
  /** Beta: a new account waits for the team's approval (only /me, sign-out and delete work meanwhile). */
  pending_approval?: boolean;
  /** Mock wallet / paper trading visible (SHOW_SIMULATIONS). */
  show_simulations?: boolean;
}
export interface Iperson {
  id: string; displayName: string; avatarUrl: string | null; personaStyle: string | null;
  handle?: string | null; publicEnabled?: boolean;
  avatarMeta: {
    mouth?: { x: number; y: number; w: number };
    scene?: { id: string; url: string | null; credit?: string; credit_url?: string };
    smartScenes?: boolean;
    selfie?: string;
  } | null;
}
export interface Fact { id: string; category: string; key: string; value: string; source: string; visibility?: 'private' | 'public'; updatedAt: string }
export interface Action {
  id: string; tool: string; args: unknown; risk: 'read' | 'write' | 'money';
  status: 'proposed' | 'confirmed' | 'rejected' | 'expired' | 'done' | 'failed';
  summary: string; amountCents: number | null; currency: string | null; result: unknown;
  expiresAt: string; createdAt: string; decidedAt: string | null;
}
export interface Wallet {
  balanceCents: number; currency: string; perActionLimitCents: number; monthlyBudgetCents: number;
  spentThisMonthCents: number; spentMonth: string | null;
}

export const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`;
