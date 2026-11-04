import { useEffect } from 'react';
import { useFeatures } from '../features.ts';

// The bar across the top of every page: a demo-mode warning when the Meta key is missing or rejected, else the
// beta notice when new accounts wait for approval, else nothing. `?showasprod` on any URL hides the beta notice
// for the rest of the tab (screenshots); `?showasprod=0` brings it back. The bar's height is the CSS variable
// --beta-h, which the body padding and the top-anchored layouts (Shell header, Talk) add to their offsets.

const KEY = 'ip_showasprod';
const BAR_H = '1.75rem';

function hidden(): boolean {
  try {
    const flag = new URLSearchParams(location.search).get('showasprod');
    if (flag !== null) {
      if (flag === '0' || flag === 'false') sessionStorage.removeItem(KEY);
      else sessionStorage.setItem(KEY, '1');
    }
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return new URLSearchParams(location.search).has('showasprod');
  }
}

// Not on the glasses app (600 × 600 display): every pixel counts there.
const allowed = !location.pathname.startsWith('/glasses');
const prodLook = hidden();

export function BetaBar() {
  const f = useFeatures();
  const demo = allowed && f !== null && (f.meta.status === 'missing' || f.meta.status === 'invalid');
  const beta = allowed && !prodLook && f !== null && f.beta_approval;
  const show = demo || beta;
  useEffect(() => {
    document.documentElement.style.setProperty('--beta-h', show ? BAR_H : '0px');
  }, [show]);
  if (!show) return null;
  if (demo) {
    return (
      <div role="alert" className="fixed inset-x-0 top-0 z-30 flex items-center justify-center gap-2 border-b border-warn/40 bg-[#2a1a06] px-3 text-xs text-warn" style={{ height: BAR_H }} title={f!.meta.message}>
        <span className="rounded-full border border-warn/60 px-1.5 text-[10px] font-semibold tracking-wider">DEMO MODE</span>
        <span className="truncate">
          <span className="sm:hidden">{f!.meta.status === 'missing' ? 'No META_API_KEY: not using Meta models.' : 'META_API_KEY rejected: not using Meta models.'}</span>
          <span className="hidden sm:inline">
            {f!.meta.status === 'missing' ? 'META_API_KEY is not set' : 'META_API_KEY was rejected'}: replies come from a simple rule-based stand-in, not Meta models. Add the key to .env and restart.
          </span>
        </span>
      </div>
    );
  }
  return (
    <div role="note" className="fixed inset-x-0 top-0 z-30 flex items-center justify-center gap-2 border-b border-rim/30 bg-[#0b1220] px-3 text-xs text-rim" style={{ height: BAR_H }}>
      <span className="rounded-full border border-rim/50 px-1.5 text-[10px] font-semibold tracking-wider">BETA</span>
      <span className="truncate">
        <span className="sm:hidden">New accounts are approved by our team first.</span>
        <span className="hidden sm:inline">i-persons is in beta: new accounts are reviewed and approved by our team before they can be used.</span>
      </span>
    </div>
  );
}
