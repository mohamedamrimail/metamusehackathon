import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { loadFeatures } from './features.ts';
import './index.css';

// Invite links (i-persons.com/?invite=CODE): keep the code for the sign-up page, also across the Google/Microsoft redirect.
try {
  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) localStorage.setItem('ip_invite', invite.trim().slice(0, 40));
  // Impact §9: a waitlist share link (/signup?wl=CODE) counts the people who join through it.
  const wl = new URLSearchParams(location.search).get('wl');
  if (wl) localStorage.setItem('ip_wl', wl.trim().slice(0, 20));
} catch { /* storage blocked: the code can still be typed */ }

// The server's optional features (WhatsApp, glasses…) are known before the first render; at most 3 s.
void Promise.race([loadFeatures(), new Promise((r) => setTimeout(r, 3000))]).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
