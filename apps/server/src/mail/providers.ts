import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.ts';

// Mailbox providers (addendum 2, M1/M2): OAuth with PKCE, read-only scopes, and mail clients that
// filter at the provider so other emails are never downloaded.

export type Provider = 'microsoft' | 'google';

export const PROVIDERS = {
  microsoft: {
    kind: 'mail_microsoft' as const,
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['openid', 'offline_access', 'User.Read', 'Mail.Read'],
    /** Asked for only when the user switches on "Import my contacts" / "Import my calendar" (incremental consent). */
    extra: { contacts: 'Contacts.Read', calendar: 'Calendars.Read' },
    clientId: () => config.MS_CLIENT_ID,
    clientSecret: () => config.MS_CLIENT_SECRET,
    revoke: null as string | null, // Graph has no per-token revoke for personal accounts; we delete the token.
  },
  google: {
    kind: 'mail_google' as const,
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    extra: { contacts: 'https://www.googleapis.com/auth/contacts.readonly', calendar: 'https://www.googleapis.com/auth/calendar.readonly' },
    clientId: () => config.GOOGLE_CLIENT_ID,
    clientSecret: () => config.GOOGLE_CLIENT_SECRET,
    revoke: 'https://oauth2.googleapis.com/revoke',
  },
};

export const redirectUri = (p: Provider) => `${config.PUBLIC_URL}/api/connections/${p}/callback`;
export const isConfigured = (p: Provider) => Boolean(PROVIDERS[p].clientId() && PROVIDERS[p].clientSecret());

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export type Extra = 'contacts' | 'calendar';

/** Mail read access, plus contacts / calendar only when the user switched those on. */
export function authorizeUrl(p: Provider, state: string, challenge: string, extras: Extra[] = []): string {
  const cfg = PROVIDERS[p];
  const q = new URLSearchParams({
    client_id: cfg.clientId()!, response_type: 'code', redirect_uri: redirectUri(p), scope: [...cfg.scopes, ...extras.map((e) => cfg.extra[e])].join(' '),
    state, code_challenge: challenge, code_challenge_method: 'S256',
    ...(p === 'google' ? { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' } : { response_mode: 'query', prompt: 'select_account' }),
  });
  return `${cfg.authorize}?${q}`;
}

/** Read-only only: any granted scope outside what we asked for (e.g. Mail.ReadWrite, gmail.modify) is refused. */
export function scopesAreReadOnly(p: Provider, granted: string): boolean {
  const allowed = new Set([...PROVIDERS[p].scopes, ...Object.values(PROVIDERS[p].extra)].map((s) => s.toLowerCase()));
  // Microsoft may echo scopes fully qualified (https://graph.microsoft.com/Mail.Read) and add `profile`/`email`.
  const harmless = new Set(['profile', 'email', 'openid']);
  return granted.split(/\s+/).filter(Boolean).every((s) => {
    const short = s.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase();
    return allowed.has(short) || allowed.has(s.toLowerCase()) || harmless.has(short);
  });
}

export interface TokenSet { access_token: string; refresh_token?: string; scope?: string; expires_in?: number; id_token?: string }

export async function tokenRequest(p: Provider, body: Record<string, string>): Promise<TokenSet> {
  const cfg = PROVIDERS[p];
  const res = await fetch(cfg.token, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId()!, client_secret: cfg.clientSecret()!, ...body }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as TokenSet & { error?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(`token ${res.status} ${data.error ?? ''}`.trim());
  return data;
}

// --- mail clients (both behind one interface so sync and tests don't care which) ---

export interface MailMeta { id: string; from: string; receivedAt: Date }
export interface MailMessage extends MailMeta { subject: string; text: string }
export interface MailApi {
  email(): Promise<string>;
  /** Only messages from these sender domains on/after `since`, newest first, at most `max`. */
  list(domains: string[], since: Date, max: number, onlyIds?: (id: string) => boolean): Promise<MailMeta[]>;
  get(id: string): Promise<MailMessage>;
  /** Life scan (opt-in): who the user writes with — addresses, subject and the provider's short preview only, no bodies. */
  personal?(since: Date, max: number): Promise<PersonMail[]>;
  /** Address book (needs the contacts scope). */
  addressBook?(): Promise<BookContact[]>;
  /** Calendar events in a range (needs the calendar scope). */
  calendar?(from: Date, to: Date): Promise<CalEvent[]>;
}

export interface Address { name: string; email: string }
export interface PersonMail { direction: 'sent' | 'received'; people: Address[]; subject: string; snippet: string; at: Date; bulk: boolean }
export interface BookContact { name: string; emails: string[]; phones: string[]; birthday?: string; groups: string[] }
export interface CalEvent { id: string; title: string; start: Date; end: Date; location?: string }

/** Automated senders: never people. */
export const AUTOMATED = /(^|[._-])(no-?reply|do-?not-?reply|notifications?|newsletters?|mailer(-daemon)?|bounces?|marketing|news|updates?|alerts?|info|support|service|hello|team|billing|accounts?|security)([._-]|@)/i;

/** "Sam Amri <sam@x.de>, lea@y.com" → addresses (quoted names with commas handled). */
export function parseAddresses(header: string): Address[] {
  const out: Address[] = [];
  for (const part of header.match(/(?:"[^"]*"|[^,])+/g) ?? []) {
    const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/) ?? part.match(/^\s*()([^\s<>]+@[^\s<>]+)\s*$/);
    if (m) out.push({ name: m[1]!.trim(), email: m[2]!.trim().toLowerCase() });
  }
  return out;
}

const ymd = (d: Date) => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;

/** Gmail search: only allowlisted senders, only inside the window (M2.4). */
export const gmailQuery = (domains: string[], since: Date) => `from:(${domains.join(' OR ')}) after:${ymd(since)}`;

/** Graph: one `$search=from:` query per domain (Graph won't combine $search with $filter); ids, sender and date only. */
export const graphListUrl = (domain: string) =>
  `https://graph.microsoft.com/v1.0/me/messages?$search=${encodeURIComponent(`"from:${domain}"`)}&$select=id,from,receivedDateTime&$top=50`;

const senderDomainOk = (from: string, domains: string[]) => {
  const host = from.toLowerCase().split('@')[1]?.replace(/>.*$/, '') ?? '';
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
};

async function getJson<T>(url: string, token: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Number(res.headers.get('retry-after') ?? 0) * 1000 || 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 20_000)));
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`mail api ${res.status}`), { status: res.status });
    return (await res.json()) as T;
  }
}

export function graphApi(token: string): MailApi {
  return {
    async email() {
      const me = await getJson<{ mail?: string; userPrincipalName?: string }>('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', token);
      return me.mail ?? me.userPrincipalName ?? '';
    },
    async list(domains, since, max) {
      const out: MailMeta[] = [];
      for (const domain of domains) {
        let url: string | undefined = graphListUrl(domain);
        while (url && out.length < max) {
          const page: { value: { id: string; from?: { emailAddress?: { address?: string } }; receivedDateTime: string }[]; '@odata.nextLink'?: string } = await getJson(url, token);
          for (const m of page.value) {
            const from = m.from?.emailAddress?.address ?? '';
            const receivedAt = new Date(m.receivedDateTime);
            // Date and sender checked here, before any body is fetched.
            if (receivedAt >= since && senderDomainOk(from, domains)) out.push({ id: m.id, from, receivedAt });
          }
          url = page['@odata.nextLink'];
        }
      }
      return out.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime()).slice(0, max);
    },
    async get(id) {
      const m = await getJson<{ id: string; subject?: string; from?: { emailAddress?: { address?: string } }; receivedDateTime: string; body?: { contentType: string; content: string } }>(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,receivedDateTime,body`, token);
      const content = m.body?.content ?? '';
      return { id: m.id, from: m.from?.emailAddress?.address ?? '', receivedAt: new Date(m.receivedDateTime), subject: m.subject ?? '', text: m.body?.contentType === 'html' ? htmlToText(content) : content };
    },
    async personal(since, max) {
      type Addr = { emailAddress?: { name?: string; address?: string } };
      type Msg = { from?: Addr; toRecipients?: Addr[]; ccRecipients?: Addr[]; subject?: string; bodyPreview?: string; sentDateTime?: string; receivedDateTime?: string; inferenceClassification?: string };
      const addr = (a?: Addr): Address[] => (a?.emailAddress?.address ? [{ name: a.emailAddress.name ?? '', email: a.emailAddress.address.toLowerCase() }] : []);
      const iso = since.toISOString();
      const out: PersonMail[] = [];
      const folders = [
        { direction: 'sent' as const, field: 'sentDateTime', url: `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$select=toRecipients,ccRecipients,subject,bodyPreview,sentDateTime&$filter=sentDateTime ge ${iso}&$orderby=sentDateTime desc&$top=100` },
        { direction: 'received' as const, field: 'receivedDateTime', url: `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$select=from,subject,bodyPreview,receivedDateTime,inferenceClassification&$filter=receivedDateTime ge ${iso}&$orderby=receivedDateTime desc&$top=100` },
      ];
      for (const f of folders) {
        let url: string | undefined = f.url;
        let n = 0;
        while (url && n < max) {
          const page: { value: Msg[]; '@odata.nextLink'?: string } = await getJson(url, token);
          for (const m of page.value) {
            n++;
            const people = f.direction === 'sent' ? [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].flatMap(addr) : addr(m.from);
            out.push({ direction: f.direction, people, subject: m.subject ?? '', snippet: (m.bodyPreview ?? '').slice(0, 240), at: new Date((f.direction === 'sent' ? m.sentDateTime : m.receivedDateTime) ?? 0), bulk: m.inferenceClassification === 'other' });
          }
          url = page['@odata.nextLink'];
        }
      }
      return out;
    },
    async addressBook() {
      type C = { displayName?: string; emailAddresses?: { address?: string }[]; mobilePhone?: string | null; homePhones?: string[]; businessPhones?: string[]; birthday?: string | null; categories?: string[] };
      const out: BookContact[] = [];
      let url: string | undefined = 'https://graph.microsoft.com/v1.0/me/contacts?$select=displayName,emailAddresses,mobilePhone,homePhones,businessPhones,birthday,categories&$top=200';
      while (url && out.length < 2000) {
        const page: { value: C[]; '@odata.nextLink'?: string } = await getJson(url, token);
        for (const c of page.value) {
          out.push({
            name: c.displayName ?? '', emails: (c.emailAddresses ?? []).map((e) => e.address?.toLowerCase() ?? '').filter(Boolean),
            phones: [c.mobilePhone, ...(c.homePhones ?? []), ...(c.businessPhones ?? [])].filter((x): x is string => Boolean(x)),
            birthday: c.birthday?.slice(0, 10) || undefined, groups: c.categories ?? [],
          });
        }
        url = page['@odata.nextLink'];
      }
      return out;
    },
    async calendar(from, to) {
      type E = { id: string; subject?: string; isCancelled?: boolean; start: { dateTime: string; timeZone?: string }; end: { dateTime: string; timeZone?: string }; location?: { displayName?: string } };
      // Without a Prefer header Graph returns times in UTC.
      const utc = (t: { dateTime: string }) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(t.dateTime) ? t.dateTime : `${t.dateTime}Z`);
      const out: CalEvent[] = [];
      let url: string | undefined = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}&$select=id,subject,start,end,location,isCancelled&$top=200`;
      while (url && out.length < 1000) {
        const page: { value: E[]; '@odata.nextLink'?: string } = await getJson(url, token);
        for (const e of page.value) if (!e.isCancelled) out.push({ id: e.id, title: e.subject || '(no title)', start: utc(e.start), end: utc(e.end), location: e.location?.displayName || undefined });
        url = page['@odata.nextLink'];
      }
      return out;
    },
  };
}

export function gmailApi(token: string): MailApi {
  const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
  return {
    async email() {
      return (await getJson<{ emailAddress: string }>(`${base}/profile`, token)).emailAddress;
    },
    async list(domains, since, max) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({ q: gmailQuery(domains, since), maxResults: '100', ...(pageToken ? { pageToken } : {}) });
        const page = await getJson<{ messages?: { id: string }[]; nextPageToken?: string }>(`${base}/messages?${q}`, token);
        ids.push(...(page.messages ?? []).map((m) => m.id));
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < max);
      // Sender and date confirmed from metadata only, before any body is fetched.
      const metas = await Promise.all(ids.slice(0, max).map(async (id) => {
        const m = await getJson<{ id: string; internalDate: string; payload: { headers: { name: string; value: string }[] } }>(`${base}/messages/${id}?format=metadata&metadataHeaders=From`, token);
        return { id, from: m.payload.headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? '', receivedAt: new Date(Number(m.internalDate)) };
      }));
      return metas.filter((m) => m.receivedAt >= since && senderDomainOk(m.from.replace(/^.*</, ''), domains));
    },
    async get(id) {
      type Part = { mimeType: string; body?: { data?: string }; parts?: Part[] };
      const m = await getJson<{ id: string; internalDate: string; payload: Part & { headers: { name: string; value: string }[] } }>(`${base}/messages/${id}?format=full`, token);
      const header = (n: string) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value ?? '';
      const find = (p: Part, type: string): string | undefined => (p.mimeType === type && p.body?.data ? p.body.data : p.parts?.map((x) => find(x, type)).find(Boolean));
      const plain = find(m.payload, 'text/plain');
      const html = find(m.payload, 'text/html');
      const decode = (d: string) => Buffer.from(d, 'base64url').toString('utf8');
      return { id, from: header('from'), receivedAt: new Date(Number(m.internalDate)), subject: header('subject'), text: plain ? decode(plain) : html ? htmlToText(decode(html)) : '' };
    },
    async personal(since, max) {
      const out: PersonMail[] = [];
      for (const [direction, q] of [['sent', `in:sent after:${ymd(since)}`], ['received', `in:inbox category:primary after:${ymd(since)}`]] as const) {
        const ids: string[] = [];
        let pageToken: string | undefined;
        do {
          const page = await getJson<{ messages?: { id: string }[]; nextPageToken?: string }>(`${base}/messages?${new URLSearchParams({ q, maxResults: '100', ...(pageToken ? { pageToken } : {}) })}`, token);
          ids.push(...(page.messages ?? []).map((m) => m.id));
          pageToken = page.nextPageToken;
        } while (pageToken && ids.length < max);
        // Headers and Gmail's short snippet only; bodies are never downloaded.
        for (let i = 0; i < Math.min(ids.length, max); i += 20) {
          const batch = await Promise.all(ids.slice(i, i + 20).map((id) => getJson<{ internalDate: string; snippet?: string; payload: { headers: { name: string; value: string }[] } }>(
            `${base}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe`, token)));
          for (const m of batch) {
            const h = (n: string) => m.payload.headers.find((x) => x.name.toLowerCase() === n)?.value ?? '';
            out.push({
              direction, people: direction === 'sent' ? parseAddresses(`${h('to')},${h('cc')}`) : parseAddresses(h('from')),
              subject: h('subject'), snippet: (m.snippet ?? '').slice(0, 240), at: new Date(Number(m.internalDate)), bulk: Boolean(h('list-unsubscribe')),
            });
          }
        }
      }
      return out;
    },
    async addressBook() {
      type P = { names?: { displayName?: string }[]; emailAddresses?: { value?: string }[]; phoneNumbers?: { value?: string }[]; birthdays?: { date?: { year?: number; month?: number; day?: number } }[]; memberships?: { contactGroupMembership?: { contactGroupResourceName?: string } }[] };
      const out: BookContact[] = [];
      let pageToken: string | undefined;
      do {
        const page = await getJson<{ connections?: P[]; nextPageToken?: string }>(`https://people.googleapis.com/v1/people/me/connections?${new URLSearchParams({ personFields: 'names,emailAddresses,phoneNumbers,birthdays,memberships', pageSize: '1000', ...(pageToken ? { pageToken } : {}) })}`, token);
        for (const c of page.connections ?? []) {
          const b = c.birthdays?.[0]?.date;
          out.push({
            name: c.names?.[0]?.displayName ?? '', emails: (c.emailAddresses ?? []).map((e) => e.value?.toLowerCase() ?? '').filter(Boolean),
            phones: (c.phoneNumbers ?? []).map((p) => p.value ?? '').filter(Boolean),
            birthday: b?.month && b.day ? `${b.year ? `${b.year}-` : ''}${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')}` : undefined,
            groups: (c.memberships ?? []).map((m) => m.contactGroupMembership?.contactGroupResourceName?.replace('contactGroups/', '') ?? '').filter((g) => g && g !== 'myContacts'),
          });
        }
        pageToken = page.nextPageToken;
      } while (pageToken && out.length < 2000);
      return out;
    },
    async calendar(from, to) {
      type E = { id: string; summary?: string; status?: string; location?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } };
      const out: CalEvent[] = [];
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250', ...(pageToken ? { pageToken } : {}) });
        const page = await getJson<{ items?: E[]; nextPageToken?: string }>(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, token);
        for (const e of page.items ?? []) {
          if (e.status === 'cancelled') continue;
          out.push({ id: e.id, title: e.summary || '(no title)', start: new Date(e.start.dateTime ?? e.start.date!), end: new Date(e.end.dateTime ?? e.end.date!), location: e.location || undefined });
        }
        pageToken = page.nextPageToken;
      } while (pageToken && out.length < 1000);
      return out;
    },
  };
}

/** Email HTML → readable text (no scripts, styles or markup). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
