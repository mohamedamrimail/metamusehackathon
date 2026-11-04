import type { ChatMessage, Llm, LlmResult, ToolSpec } from './llm.ts';

// HACKATHON: a rule-based stand-in for Muse Spark when META_API_KEY is empty, so the whole product
// (voice, confirm cards, wallet, activity) can be built and clicked through before the key arrives.
// It speaks through the same tool calls, so the runtime's safety rules apply unchanged.

let n = 0;
const say = (content: string): LlmResult => ({ content, toolCalls: [] });
const call = (name: string, args: unknown): LlmResult =>
  ({ content: '', toolCalls: [{ id: `demo_${++n}`, name, arguments: JSON.stringify(args) }] });

const text = (m: ChatMessage | undefined) => (typeof m?.content === 'string' ? m.content : '');

function nextWeekday(now: Date, day: number, hour: number): string {
  const d = new Date(now);
  const add = ((day - d.getUTCDay() + 7) % 7) || 7;
  d.setUTCDate(d.getUTCDate() + add);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00`;
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export class DemoLlm implements Llm {
  constructor(private now: () => Date = () => new Date()) {}

  async complete({ messages, tools }: { messages: ChatMessage[]; tools: ToolSpec[] }): Promise<LlmResult> {
    // find_opportunities sub-call: canned, clearly-labelled sample items.
    if (text(messages[0]).startsWith('You find concrete')) {
      return say(JSON.stringify({ items: [
        { title: 'Demo: Tunis → Malta, 3 nights, beach hotel', why: 'Short flight, sun, within budget', price: 'from 690 TND', when: 'next month' },
        { title: 'Demo: Djerba weekend, all inclusive', why: 'Beach, no flight change', price: 'from 420 TND', when: 'this weekend' },
      ] }));
    }

    // The trailing system message is per-turn context; the turn itself is the message before it.
    const last = messages.findLast((m) => m.role !== 'system');
    if (last?.role === 'tool') {
      // Results may come wrapped in an <untrusted> block: read the JSON inside it.
      const raw = text(last);
      const json = raw.trim().startsWith('<untrusted') ? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1) : raw;
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(json || '{}'); } catch { /* not JSON */ }
      return say(this.afterTool(parsed));
    }
    const t = text(last).toLowerCase();

    if (t.startsWith('[i-persons system notice')) {
      if (t.includes('approved and done')) return say(`Done: ${/action "(.*)" \(/i.exec(text(last))?.[1] ?? 'all set'}.`);
      if (t.includes('failed')) return say("That didn't work: " + (/failed: (.*)\. tell/i.exec(text(last))?.[1] ?? 'unknown error'));
      return say('Okay.');
    }
    if (!tools.length) return say('Here is what I have so far.');

    const day = DAYS.findIndex((d) => t.includes(d));
    const hour = Number(/\b(\d{1,2})\s*(pm|h|:00)/.exec(t)?.[1] ?? 18);
    const h24 = /pm/.test(t) && hour < 12 ? hour + 12 : hour;

    if (/\b(book|réserve|reserve|yoga|class)\b/.test(t)) {
      const start = nextWeekday(this.now(), day >= 0 ? day : 2, h24);
      const end = start.replace(/T(\d\d)/, (_, hh) => `T${String(Number(hh) + 1).padStart(2, '0')}`);
      // "Book table tennis for sunday at 5pm" → "Table tennis"; the words after "book" up to the time/day.
      const what = /\b(?:book|réserve|reserve)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?(.+?)(?=\s+(?:for|on|at|this|next|tomorrow|today|in|le|pour|à|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b|\s+\d|[.,!?]|$)/i.exec(text(last))?.[1];
      const title = what ? what[0]!.toUpperCase() + what.slice(1) : t.includes('yoga') ? 'Yoga class' : 'Class';
      const place = /\bat\s+(?!\d)([a-z][\w' -]{1,40}?)(?=\s+(?:on|for|at|this|next)\b|[.,!?]|$)/i.exec(text(last))?.[1];
      return call('calendar_book', { title, start, end, ...(place ? { location: place } : t.includes('yoga') ? { location: 'Zen Studio' } : {}) });
    }
    if (/\b(calendar|schedule|agenda|busy|free)\b/.test(t)) {
      const from = this.now().toISOString().slice(0, 10);
      const to = new Date(this.now().getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
      return call('calendar_list', { from: `${from}T00:00`, to: `${to}T23:59` });
    }
    if (/\b(invite|invites|invitation|party)\b/.test(t)) {
      return call('send_email', {
        to: ['friends@example.com'], subject: "Sam's surprise party",
        body: "Hi! We're throwing Sam a surprise party on Saturday at 8 PM. Keep it secret and reply if you can come!",
      });
    }
    if (/\b(order|commande|pizza|groceries)\b/.test(t)) {
      return call('place_order', { merchant: 'Demo Pizzeria', items: [{ name: 'Margherita pizza', qty: 2, price: 12.5 }], total: 25, currency: 'TND' });
    }
    if (/\b(portfolio|positions)\b/.test(t)) return call('portfolio_status', {});
    if (/\b(trade|shares|stock)\b/.test(t)) {
      const sym = /\b(aapl|msft|meta|nvda|tsla|amzn|googl)\b/.exec(t)?.[1] ?? 'META';
      return call('paper_trade', { symbol: sym, side: /\bsell\b/.test(t) ? 'sell' : 'buy', qty: Number(/\b(\d+)\s*shares?/.exec(t)?.[1] ?? 2) });
    }
    if (/\b(wallet|balance|budget)\b/.test(t)) return call('wallet_status', {});
    if (/\b(travel|trip|holiday|vacation|deal|job|opportunit)/.test(t)) {
      return call('find_opportunities', { kind: /job/.test(t) ? 'job' : 'travel', query: t.slice(0, 200) });
    }
    const pref = /\bi (?:really )?(like|love|prefer|hate|always|never|usually)\b(.*)/.exec(t);
    if (pref) {
      const category = pref[1] === 'always' || pref[1] === 'usually' ? 'routine' : 'preference';
      const key = (pref[2] ?? '').trim().split(/\s+/).slice(0, 3).join('_').replace(/[^\p{L}\p{N}_]/gu, '') || 'note';
      return call('remember_fact', { category, key, value: `${pref[1]}${pref[2]}`.trim() });
    }
    return say("I'm in demo mode without Muse Spark yet. Try: book yoga Tuesday 6pm, send the party invites, check my calendar, or find me a beach trip.");
  }

  private afterTool(r: Record<string, unknown>): string {
    if (r.error) return `I couldn't do that: ${String(r.error)}.`;
    if (r.status === 'awaiting_confirmation') return `Shall I go ahead? ${String(r.summary)}.`;
    if (r.saved) return "Got it, I'll remember that.";
    if (Array.isArray(r.events)) {
      const ev = r.events as { title: string; start: string }[];
      return ev.length
        ? `This week: ${ev.slice(0, 4).map((e) => `${e.title} on ${e.start.slice(5, 10)} at ${e.start.slice(11, 16)}`).join('; ')}.`
        : 'Your week is free.';
    }
    if (Array.isArray(r.items)) {
      const it = r.items as { title: string; price?: string }[];
      return it.length ? `I found ${it.length}: ${it.map((i) => `${i.title}${i.price ? ` (${i.price})` : ''}`).join('; ')}.` : 'Nothing worth your time right now.';
    }
    if (Array.isArray(r.positions)) {
      const p = r.positions as { symbol: string; qty: number; unrealized_pnl: number }[];
      return p.length ? `Simulation portfolio: ${p.map((x) => `${x.qty} ${x.symbol} (${x.unrealized_pnl >= 0 ? '+' : ''}${x.unrealized_pnl} USD)`).join(', ')}.` : 'Your simulated portfolio is empty.';
    }
    if (r.balance) return `You have ${String(r.balance)} in the wallet, ${String(r.left_this_month)} left this month.`;
    return 'Done.';
  }
}
