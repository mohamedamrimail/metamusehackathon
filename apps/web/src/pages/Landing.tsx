import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';
import { ImpactCounter } from '../components/Impact.tsx';
import { useSession } from '../session.tsx';

export function Landing() {
  const { user, iperson } = useSession();
  const next = !user ? '/signup' : iperson?.avatarUrl ? '/talk' : '/onboarding';
  return (
    <div className="rim-glow relative flex min-h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between px-6 py-5">
        <span className="font-semibold tracking-tight">i-persons</span>
        {user ? <Link to={next} className="text-sm text-muted hover:text-white">Open my i-person →</Link>
          : <Link to="/login" className="text-sm text-muted hover:text-white">Sign in</Link>}
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
        <Silhouettes />
        <h1 className="mt-10 text-4xl font-semibold tracking-tight sm:text-6xl">
          Your i-person knows you,<br className="hidden sm:block" /> speaks for you, acts for you.
        </h1>
        <p className="mt-5 max-w-xl text-lg text-muted">
          A digital twin that looks like you and gets things done — but never without your yes.
        </p>
        <Link to={next} className="mt-9 rounded-full bg-white px-8 py-3.5 font-medium text-black transition hover:bg-white/90">
          {user ? 'Continue' : 'Create my i-person'}
        </Link>
        <ImpactCounter />
        <WaitlistLine />
        {!user && <a href="https://wa.me/21655397770?text=Hi" target="_blank" rel="noreferrer" className="mt-4 text-sm text-muted underline hover:text-white">or say hi on WhatsApp</a>}

        <Section title="One twin, three things it does for you">
          <Cards cols={3} items={[
            ['It acts for you', 'Talk to it by voice, on WhatsApp or on your glasses: it books meetings, sends emails and prepares hotel, flight and shopping links, then waits for your yes.'],
            ['It learns you', 'It remembers what matters, follows your rules and learns from your orders and bookings, only with your permission. Everything it knows is on My twin, editable.'],
            ['It speaks for you', 'Your public twin talks to visitors and recruiters and only says what you made public. With friends on i-persons, your twins plan coffee and dinners together.'],
          ]} />
        </Section>

        <Section title="Wherever you are">
          <Cards cols={4} items={[
            ['On the web and your phone', 'Hold the mic and talk; your twin answers out loud. Add it to your home screen with your twin’s face as the icon.'],
            ['On WhatsApp', 'Text, voice notes and photos. Approve with one tap. You can even start a twin right there.'],
            ['On Meta Ray-Ban Display', 'Your twin floats in your glasses, says its replies, and you approve with the Neural Band.'],
            ['Twin to twin', 'Your twins find a time that suits you both and propose real places. Booked only when both say yes.'],
          ]} />
        </Section>

        <Section title="Never without your yes">
          <ul className="grid gap-3 text-left text-sm text-muted sm:grid-cols-2">
            {[
              'Every booking, email or request in your name is an Approve / Decline card first.',
              'Your rules are checked on every action. If the check can’t run, it waits for your tap.',
              'Nothing it reads on the web or in emails can plant memories or act without you.',
              'Your contacts and private facts never reach visitors, partners or other twins.',
            ].map((t) => <li key={t} className="flex gap-2 rounded-xl border border-line bg-panel/40 p-4"><span className="text-ok">✓</span><span>{t}</span></li>)}
          </ul>
        </Section>

        <Section title="For your family, and as a gift">
          <Cards cols={2} items={[
            ['Family plan', 'One person pays a shared AI credit pool for up to five people, for example grandparents. You see their spend, never their conversations.'],
            ['Gift a twin', 'Give someone their own i-person. They get a code by email or from your own WhatsApp.'],
          ]} />
          <Link to="/pricing" className="mt-5 inline-block text-sm underline">See pricing</Link>
        </Section>

        <p className="mt-16 max-w-xl text-xs text-muted">i-persons is in beta: new accounts are reviewed by our team before they can be used. Open in Germany, Tunisia, Denmark, Spain and the US; elsewhere, join the waitlist.</p>
      </main>
      <footer className="space-y-1 pb-8 text-center text-xs text-muted">
        <p>i-persons is developed and operated by <a href="https://yousoft-it.com/" className="underline">Yousoft-IT</a>.</p>
        <p>Built on Meta Muse models, WhatsApp and Meta Ray-Ban Display · <Link to="/pricing" className="underline">Pricing</Link> · <Link to="/gift" className="underline">Gift a twin</Link> · <a href="/privacy.html" className="underline">Privacy</a> · <a href="/terms.html" className="underline">Terms</a> · <a href="/data-deletion.html" className="underline">Delete data</a></p>
        <p>i-persons is a product of <a href="https://yousoft-it.com/" className="underline">Yousoft-IT</a>. © {new Date().getFullYear()} Yousoft-IT. All rights reserved.</p>
      </footer>
    </div>
  );
}

/** Abstract group of silhouettes with a rim light, standing in for the campaign photo. */
function Silhouettes() {
  const people = [[-150, 0.78, 0.35], [-75, 0.9, 0.55], [0, 1.05, 1], [75, 0.9, 0.55], [150, 0.78, 0.35]] as const;
  return (
    <svg viewBox="-220 -40 440 220" className="w-full max-w-md" aria-hidden>
      <defs>
        <linearGradient id="rim" x1="0" x2="1">
          <stop offset="0" stopColor="#9ec5ff" stopOpacity="0.9" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.15" />
          <stop offset="1" stopColor="#9ec5ff" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      {people.map(([x, s, o]) => (
        <g key={x} transform={`translate(${x} ${(1 - s) * 90}) scale(${s})`} opacity={o}>
          <circle cx="0" cy="30" r="26" fill="#0b0c10" stroke="url(#rim)" strokeWidth="1.5" />
          <path d="M-58 180 C-55 110 -30 78 0 78 C30 78 55 110 58 180 Z" fill="#0b0c10" stroke="url(#rim)" strokeWidth="1.5" />
        </g>
      ))}
    </svg>
  );
}

/** Impact §9: "People in <n> countries are waiting for i-persons" (admin toggle; real waitlist rows). */
function WaitlistLine() {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => { api<{ countries: number | null }>('/waitlist/summary').then((r) => setN(r.countries)).catch(() => {}); }, []);
  if (!n) return null;
  return <p className="mt-4 text-sm text-muted">People in <span className="text-white">{n} {n === 1 ? 'country' : 'countries'}</span> are waiting for i-persons</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-20 w-full">
      <h2 className="mb-6 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
      {children}
    </section>
  );
}

function Cards({ items, cols }: { items: [string, string][]; cols: 2 | 3 | 4 }) {
  const grid = cols === 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : cols === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2';
  return (
    <div className={`grid w-full gap-4 text-left ${grid}`}>
      {items.map(([t, d]) => (
        <div key={t} className="rounded-2xl border border-line bg-panel/60 p-5">
          <div className="font-medium">{t}</div>
          <div className="mt-1.5 text-sm text-muted">{d}</div>
        </div>
      ))}
    </div>
  );
}
