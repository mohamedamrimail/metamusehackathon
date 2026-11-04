import { useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from './api.ts';
import { Activity } from './pages/Activity.tsx';
import { Admin } from './pages/Admin.tsx';
import { Contacts } from './pages/Contacts.tsx';
import { Join } from './pages/Join.tsx';
import { Auth } from './pages/Auth.tsx';
import { DemoHandoff } from './pages/DemoHandoff.tsx';
import { Developers } from './pages/Developers.tsx';
import { OrgPortal } from './pages/OrgPortal.tsx';
import { Console } from './pages/Console.tsx';
import { ImpactMethod } from './components/Impact.tsx';
import { SessionPage } from './components/Growth.tsx';
import { PublicTwin } from './pages/PublicTwin.tsx';
import { Landing } from './pages/Landing.tsx';
import { Onboarding } from './pages/Onboarding.tsx';
import { ProfileStep } from './pages/Profile.tsx';
import { Store } from './pages/Store.tsx';
import { Family, FamilyJoin, Gift, Pricing, Redeem } from './pages/Pricing.tsx';
import { Glasses } from './pages/Glasses.tsx';
import { Talk } from './pages/Talk.tsx';
import { Twin } from './pages/Twin.tsx';
import { SessionProvider, useSession } from './session.tsx';
import { BetaBar } from './components/BetaBar.tsx';
import { CallsPanel } from './components/CallsPanel.tsx';

export function App() {
  return (
    <SessionProvider>
      <BetaBar />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/developers" element={<Developers />} />
          {/* DEMO: neutral hand-off pages for demo accounts (/demo/stay, /demo/fly, /demo/shop). */}
          <Route path="/demo/:page" element={<DemoHandoff />} />
          <Route path="/login" element={<Auth mode="login" />} />
          <Route path="/signup" element={<Auth mode="signup" />} />
          <Route path="/join/:token" element={<Join />} />
          <Route path="/onboarding" element={<Guard needTwin={false}><Onboarding /></Guard>} />
          <Route path="/talk" element={<Guard><Shell><Talk /></Shell></Guard>} />
          <Route path="/twin" element={<Guard><Shell><Twin /></Shell></Guard>} />
          <Route path="/contacts" element={<Guard><Shell><Contacts /></Shell></Guard>} />
          <Route path="/activity" element={<Guard><Shell><Activity /></Shell></Guard>} />
          <Route path="/store" element={<Guard><Shell><Store /></Shell></Guard>} />
          <Route path="/org/yousoft" element={<Guard needTwin={false}><Shell><OrgPortal /></Shell></Guard>} />
          <Route path="/impact-method" element={<ImpactMethod />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/glasses" element={<Glasses />} />
          <Route path="/gift" element={<Gift />} />
          <Route path="/redeem" element={<Redeem />} />
          <Route path="/family" element={<Family />} />
          <Route path="/family/join/:token" element={<FamilyJoin />} />
          <Route path="/s/:code" element={<SessionPage />} />
          <Route path="/console" element={<Guard needTwin={false}><Shell><Console /></Shell></Guard>} />
          <Route path="/console/:slug" element={<Guard needTwin={false}><Shell><Console /></Shell></Guard>} />
          <Route path="/admin" element={<Guard needTwin={false}><Shell><Admin /></Shell></Guard>} />
          {/* i-persons.com/@handle — the public twin (any other unknown path goes home). */}
          <Route path="/:slug" element={<PublicTwin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}

/** Signed-in only; sends users who haven't finished setup to onboarding (which asks for consent itself). */
function Guard({ children, needTwin = true }: { children: ReactNode; needTwin?: boolean }) {
  const { loading, user, iperson } = useSession();
  if (loading) return <div className="grid h-full place-items-center text-muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.pending_approval) return <PendingApproval />;
  if (user.consent_required && user.onboarded) return <ProfileStep />;
  if (needTwin && (!user.onboarded || !iperson?.avatarUrl)) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const { user, refresh } = useSession();
  const link = ({ isActive }: { isActive: boolean }) =>
    `whitespace-nowrap rounded-full px-2.5 py-1.5 text-sm transition sm:px-3 ${isActive ? 'bg-white text-black' : 'text-muted hover:text-white'}`;
  return (
    // DEMO: the docked Meta AI calls panel takes --calls-w on the right; the page narrows instead of hiding under it.
    <div className="flex min-h-full flex-col" style={{ paddingRight: 'var(--calls-w, 0px)' }}>
      <header style={{ top: 'var(--beta-h, 0px)' }} className="sticky z-20 flex items-center justify-between gap-2 border-b border-line bg-ink/80 px-4 py-3 backdrop-blur">
        <span className="shrink-0 font-semibold tracking-tight">
          <img src="/favicon.svg" alt="i-persons" className="h-7 w-7 sm:hidden" />
          <span className="hidden sm:inline">i-persons</span>
        </span>
        <nav className="flex min-w-0 gap-0.5 overflow-x-auto sm:gap-1">
          <NavLink to="/talk" className={link}>Talk</NavLink>
          <NavLink to="/store" className={link}>Store</NavLink>
          <NavLink to="/twin" className={link}>My twin</NavLink>
          <NavLink to="/contacts" className={link}>Contacts</NavLink>
          <NavLink to="/activity" className={link}>Activity</NavLink>
        </nav>
        <button
          className="shrink-0 whitespace-nowrap text-xs text-muted hover:text-white sm:text-sm"
          onClick={async () => { await api('/auth/logout', { method: 'POST' }); await refresh(); nav('/'); }}
        >
          Sign out
        </button>
      </header>
      {user?.account_kind === 'demo' && <DemoBanner />}
      <main className="flex flex-1 flex-col">{children}</main>
      <CallsPanel />
    </div>
  );
}

/** The judges' demo account: says the data is sample data and what to try. Floats, so page heights don't change. */
function DemoBanner() {
  const [open, setOpen] = useState(() => { try { return !sessionStorage.getItem('ip_demo_banner'); } catch { return true; } });
  if (!open) return null;
  return (
    <div style={{ top: 'calc(4rem + var(--beta-h, 0px))', right: 'calc(0.75rem + var(--calls-w, 0px))' }} className="fixed inset-x-3 z-40 mx-auto flex max-w-xl items-start gap-3 rounded-2xl border border-rim/40 bg-panel/95 px-4 py-3 text-sm shadow-lg backdrop-blur">
      <p className="flex-1"><strong>Demo account</strong>: data is sample data. Try: <span className="text-rim">“Find me a hotel in Munich like last time”</span>.</p>
      <button aria-label="Close" className="text-muted hover:text-white" onClick={() => { setOpen(false); try { sessionStorage.setItem('ip_demo_banner', '1'); } catch { /* ignore */ } }}>✕</button>
    </div>
  );
}

/** Beta: a new account waits until the team approves it (the request went to contact@i-persons.com). */
function PendingApproval() {
  const nav = useNavigate();
  const { user, refresh } = useSession();
  const [checking, setChecking] = useState(false);
  return (
    <div className="rim-glow grid min-h-full place-items-center px-6 py-10 text-center">
      <div className="max-w-md space-y-4">
        <img src="/favicon.svg" alt="" className="mx-auto h-12 w-12" />
        <h1 className="text-2xl font-semibold tracking-tight">Thanks for joining, {user?.name.split(/\s+/)[0]}!</h1>
        <p className="text-muted">i-persons is in beta, so our team approves every new account before it can be used. We’ve received yours and will email <span className="text-white">{user?.email}</span> as soon as it’s approved.</p>
        <p className="text-sm text-muted">Questions? Write to contact@i-persons.com.</p>
        <div className="flex justify-center gap-3 pt-2">
          <button className="rounded-full bg-white px-4 py-2 text-sm text-black disabled:opacity-60" disabled={checking}
            onClick={async () => { setChecking(true); await refresh(); setChecking(false); }}>{checking ? 'Checking…' : 'Check again'}</button>
          <button className="rounded-full border border-line px-4 py-2 text-sm text-muted hover:text-white"
            onClick={async () => { await api('/auth/logout', { method: 'POST' }); await refresh(); nav('/'); }}>Sign out</button>
        </div>
      </div>
    </div>
  );
}
