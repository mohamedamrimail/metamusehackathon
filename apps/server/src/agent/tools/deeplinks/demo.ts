import { demoServiceFor } from '@ipersons/shared';
import { config } from '../../../config.ts';

// DEMO: hand-off links for demo accounts (users.account_kind 'demo') open the neutral demo pages
// (/demo/stay, /demo/fly, /demo/shop on our own site) with the filters already filled in, never a real site.

export function demoHandoffUrl(provider: 'booking' | 'skyscanner' | 'amazon', params: Record<string, string | number | boolean | undefined>): string {
  const s = demoServiceFor(provider)!;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== false && v !== '') q.set(k, v === true ? '1' : String(v));
  return `${config.PUBLIC_URL.replace(/\/$/, '')}/demo/${s.page}?${q}`;
}
