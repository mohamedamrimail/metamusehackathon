import { useEffect, useState } from 'react';

// "Add to home screen": Android/Chrome offers a real install prompt (captured here at startup, since it
// fires once and early); iPhone has no API, so we show the two taps in Safari's share menu.

interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }

let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    listeners.forEach((f) => f());
  });
  window.addEventListener('appinstalled', () => { deferred = null; listeners.forEach((f) => f()); });
}

const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = () => isIos() || /Android|Mobile/i.test(navigator.userAgent);

/** `avatarUrl` versions the iPhone icon link, so Safari picks up a changed avatar instead of a cached icon. */
export function InstallApp({ avatarUrl }: { avatarUrl?: string | null }) {
  const [, bump] = useState(0);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (link && avatarUrl) link.href = `/api/me/app-icon-180.png?v=${encodeURIComponent(avatarUrl.split('/').pop() ?? '')}`;
  }, [avatarUrl]);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);

  // Already opened from the home screen, or a computer: nothing to offer.
  if (standalone() || (!isMobile() && !deferred)) return null;

  const add = async () => {
    if (!deferred) return setHelp(true);
    await deferred.prompt();
    await deferred.userChoice.catch(() => undefined);
    deferred = null;
    bump((n) => n + 1);
  };

  return (
    <>
      <button onClick={add} title="Add to home screen" aria-label="Add i-persons to your home screen"
        className="grid h-10 w-10 place-items-center rounded-full border border-line bg-panel/80 text-white/80 hover:text-white">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
          <path d="M12 8.5v6M9 11.5h6" />
        </svg>
      </button>
      {help && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4" onClick={() => setHelp(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <p className="mb-3 text-base font-medium">Add i-persons to your home screen</p>
            {isIos() ? (
              <ol className="list-decimal space-y-2 pl-5 text-white/80">
                <li>Open this page in <b>Safari</b>.</li>
                <li>Tap the <b>Share</b> button <ShareIcon /> at the bottom of the screen.</li>
                <li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
              </ol>
            ) : (
              <ol className="list-decimal space-y-2 pl-5 text-white/80">
                <li>Open the browser menu <b>⋮</b> (top right).</li>
                <li>Tap <b>Add to Home screen</b> or <b>Install app</b>.</li>
              </ol>
            )}
            <p className="mt-3 text-muted">The icon shows your twin and opens straight into Talk.{isIos() ? ' Sign in once more the first time you open it.' : ''}</p>
            <button onClick={() => setHelp(false)} className="mt-4 w-full rounded-full border border-line py-2">Got it</button>
          </div>
        </div>
      )}
    </>
  );
}

const ShareIcon = () => (
  <svg viewBox="0 0 24 24" className="inline h-4 w-4 align-[-2px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12M8 7l4-4 4 4M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
  </svg>
);
