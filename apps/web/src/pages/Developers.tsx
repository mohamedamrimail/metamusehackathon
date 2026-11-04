import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { Button } from '../components/ui.tsx';

// /developers (P7): what partners can do, the consent model, scopes, quick start, webhook check, apply.

const SCOPES = [
  ['offers:write', 'Publish offers: jobs, deals, events, services.'],
  ['matches:read', 'See which twins match an offer: a pseudonymous id, a score and one line of why. No names.'],
  ['twins:converse', 'Ask a matched twin questions. It answers only from what its person allows, and never commits to anything.'],
  ['requests:write', 'Ask the person for an interview, their CV, their contact or something else. Every request is an Approve/Decline card.'],
  ['webhooks:manage', 'Get signed events: match.created, request.approved/declined/expired, offer.dismissed, user.revoked.'],
];

const CURL = `# 1. Token (15 minutes)
curl -s -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials \\
  https://i-persons.com/api/partner/v1/oauth/token

# 2. Publish an offer — matching starts right away
curl -s https://i-persons.com/api/partner/v1/offers -H "Authorization: Bearer $TOKEN" \\
  -H 'Content-Type: application/json' -d '{"type":"job","title":"React internship",
  "description":"Six months, Tunis or remote.","requirements":{"skills":["React","TypeScript"]},"countries":["TN","DE"]}'

# 3. Who matches?
curl -s https://i-persons.com/api/partner/v1/offers/$OFFER_ID/matches -H "Authorization: Bearer $TOKEN"

# 4. Ask for an interview — the person approves or declines
curl -s https://i-persons.com/api/partner/v1/twins/$TWIN_ID/requests -H "Authorization: Bearer $TOKEN" \\
  -H 'Content-Type: application/json' -d '{"kind":"schedule","offer_id":"'$OFFER_ID'","slots":["2026-11-10T09:00:00Z"]}'`;

const VERIFY = `import { createHmac, timingSafeEqual } from 'node:crypto';

// X-IPersons-Signature: "t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">"
export function verifyIPersons(secret: string, rawBody: string, header: string): boolean {
  const t = Number(/t=(\\d+)/.exec(header)?.[1]);
  const v1 = /v1=([0-9a-f]+)/.exec(header)?.[1] ?? '';
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false; // 5-minute tolerance
  const want = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return want.length === v1.length && timingSafeEqual(Buffer.from(want), Buffer.from(v1));
}`;

export function Developers() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const code = 'overflow-x-auto rounded-2xl border border-line bg-panel p-4 text-xs leading-relaxed';
  return (
    <div className="mx-auto w-full max-w-3xl space-y-10 px-4 py-10">
      <header className="space-y-3">
        <Link to="/" className="text-sm font-semibold">i-persons</Link>
        <h1 className="text-4xl font-semibold tracking-tight">Talk to twins, not to data.</h1>
        <p className="text-lg text-muted">The i-persons Partner API lets companies reach people through their digital twins: publish offers, see who fits, ask a twin questions, and send requests the person approves. You never see who someone is until they say yes.</p>
        <div className="flex gap-3">
          <a href="#apply" className="rounded-full bg-white px-5 py-2.5 text-sm font-medium text-black">Become a partner</a>
          <a href="/developers-api.html" className="rounded-full border border-line px-5 py-2.5 text-sm">API reference</a>
        </div>
      </header>

      <section className="space-y-2 rounded-2xl border border-line p-4 text-sm text-white/85">
        <h2 className="text-base font-semibold">Disclosure: our first partner</h2>
        <p>Yousoft-IT both operates i-persons and is its first partner (recruiting). Its recruiter portal uses only this public Partner API, with the same consent rules, scopes and limits as any other partner, and has no private access to anyone’s data. Its Store card says “Operated by the i-persons team”.</p>
        <p>No developers? Partners can also use the <strong>partner console</strong> to post offers, see anonymous matches and follow requests, without writing code. Members sign in and open <code>/console</code>.</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">How consent works</h2>
        <ul className="space-y-2 text-sm text-white/85">
          <li>• People activate you in their Service Store and choose what you may do: send them offers, talk to their twin, ask them for things. They can pause or block you at any time.</li>
          <li>• You see a <strong>pseudonymous twin id</strong> per person, different for every partner, so ids can’t be linked across companies.</li>
          <li>• Twins answer only from what the person lets them share. They can’t accept, schedule or promise anything.</li>
          <li>• Interviews, CVs and contact details are <strong>requests</strong>: the person gets an Approve/Decline card on the web and on WhatsApp. Shared data reaches you once, in the webhook or the request’s next read.</li>
          <li>• Matching never uses gender or age. Offers reach only people in countries where i-persons is open, and in the countries you choose.</li>
          <li>• Everything you send is treated as untrusted text; it can’t make a twin do anything.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Scopes</h2>
        <table className="w-full text-sm"><tbody>
          {SCOPES.map(([s, d]) => <tr key={s} className="border-t border-line align-top"><td className="whitespace-nowrap py-2 pr-3"><code>{s}</code></td><td className="py-2 text-muted [overflow-wrap:anywhere]">{d}</td></tr>)}
        </tbody></table>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Quick start</h2>
        <pre className={code}><code>{CURL}</code></pre>
        <h3 className="pt-2 font-medium">Verify webhooks (TypeScript)</h3>
        <pre className={code}><code>{VERIFY}</code></pre>
        <p className="text-sm text-muted">Failed deliveries are retried with exponential backoff for 24 hours. Fair use: per-minute rate limits, daily caps per offer, at most 3 pending requests per person; partners with poor approval rates or reports are throttled.</p>
      </section>

      <section id="apply" className="space-y-3">
        <h2 className="text-xl font-semibold">Become a partner</h2>
        {sent ? <p className="rounded-2xl border border-ok/40 bg-ok/10 p-4 text-sm">Thanks! We review every application by hand and will email you.</p> : (
          <form className="grid gap-3 text-sm sm:grid-cols-2" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            setError(null);
            try {
              await api('/partner-applications', { body: {
                company: f.get('company'), website: f.get('website'), country: String(f.get('country')).toUpperCase(), contact_name: f.get('contact'),
                email: f.get('email'), category: f.get('category'), intended_use: f.get('use'), requested_scopes: f.getAll('scopes'),
              } });
              setSent(true);
            } catch (err) {
              setError(err instanceof ApiError ? 'Please check the fields (the description needs 20+ characters, pick at least one scope).' : 'Something went wrong.');
            } finally {
              setBusy(false);
            }
          }}>
            {[['company', 'Company name'], ['website', 'Website (https://…)'], ['country', 'Country (2 letters, e.g. DE)'], ['contact', 'Contact person'], ['email', 'Email']].map(([n, l]) => (
              <input key={n} name={n} required placeholder={l} aria-label={l} type={n === 'email' ? 'email' : n === 'website' ? 'url' : 'text'} maxLength={n === 'country' ? 2 : 200}
                className="rounded-xl border border-line bg-panel px-4 py-3 outline-none" />
            ))}
            <select name="category" aria-label="Category" className="rounded-xl border border-line bg-panel px-4 py-3">
              {['jobs', 'shopping', 'travel', 'productivity', 'other'].map((c) => <option key={c} value={c}>{c[0]!.toUpperCase() + c.slice(1)}</option>)}
            </select>
            <textarea name="use" required minLength={20} rows={3} placeholder="What will you use it for?" aria-label="Intended use" className="rounded-xl border border-line bg-panel px-4 py-3 outline-none sm:col-span-2" />
            <fieldset className="space-y-1.5 sm:col-span-2">
              <legend className="mb-1 text-xs uppercase tracking-wider text-muted">Scopes you need</legend>
              {SCOPES.map(([s]) => <label key={s} className="mr-4 inline-flex items-center gap-2"><input type="checkbox" name="scopes" value={s} className="accent-white" defaultChecked={s !== 'webhooks:manage'} /><code>{s}</code></label>)}
            </fieldset>
            {error && <p className="text-bad sm:col-span-2">{error}</p>}
            <Button disabled={busy} className="py-3 sm:col-span-2">Apply</Button>
          </form>
        )}
      </section>
    </div>
  );
}
