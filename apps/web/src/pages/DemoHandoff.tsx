import { DEMO_SERVICES, demoFlights, demoProducts, demoStays } from '@ipersons/shared';
import { useParams, useSearchParams } from 'react-router-dom';

// DEMO: the neutral hand-off pages (i-persons.com/demo/stay|fly|shop?…) that demo accounts' prefilled links
// open instead of a real site. They show the filters the twin filled in and sample listings; nothing is
// booked or bought here. No account needed (the link arrives on WhatsApp).

const day = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};

export function DemoHandoff() {
  const { page = '' } = useParams();
  const [q] = useSearchParams();
  const s = DEMO_SERVICES.find((x) => x.page === page);
  if (!s) return <div className="grid min-h-full place-items-center p-6 text-muted">Unknown demo page.</div>;

  const filters: [string, string][] = [];
  let results: { title: string; sub: string; price: string; tag?: string }[] = [];
  if (s.page === 'stay') {
    const city = q.get('city') ?? 'Munich';
    const stars = q.get('stars') ? Number(q.get('stars')) : undefined;
    const fc = q.get('fc') === '1';
    filters.push(['Destination', city], ['Check-in', day(q.get('checkin'))], ['Check-out', day(q.get('checkout'))], ['Guests', `${q.get('adults') ?? 2} adults, 1 room`]);
    if (stars) filters.push(['Stars', `${stars}★`]);
    if (fc) filters.push(['Free cancellation', 'Yes']);
    results = demoStays(city, { stars, freeCancellation: fc }).map((h) => ({ title: h.title, sub: `${h.area} · ${h.rating.toFixed(1)} guest rating${h.freeCancellation ? ' · Free cancellation' : ''}`, price: `€${h.pricePerNight}`, tag: 'per night' }));
  } else if (s.page === 'fly') {
    const from = q.get('from') ?? 'TUN';
    const to = q.get('to') ?? 'MUC';
    filters.push(['From', from], ['To', to], ['Depart', day(q.get('depart'))]);
    if (q.get('return')) filters.push(['Return', day(q.get('return'))]);
    filters.push(['Travellers', `${q.get('adults') ?? 1} adult`]);
    results = demoFlights(from, to).map((f) => ({ title: f.title, sub: `${f.depart} → ${f.arrive}`, price: `€${f.price}`, tag: 'return' }));
  } else {
    const item = q.get('item') ?? '';
    filters.push(['Item', item || 'Your usual'], ['Quantity', q.get('qty') ?? '1']);
    if (q.get('cart') === '1') filters.push(['Basket', 'Ready to review']);
    results = demoProducts(item, q.get('ref') ?? undefined).map((p) => ({ title: p.title, sub: p.note, price: `€${p.price.toFixed(2)}` }));
  }

  return (
    <div className="min-h-full bg-[#f6f7f9] text-[#111827]">
      <header className="flex items-center gap-3 border-b border-black/10 bg-white px-4 py-3">
        <img src={s.icon} alt="" className="h-9 w-9 rounded-xl" />
        <span className="text-lg font-semibold">{s.name}</span>
        <span className="ml-auto rounded-full bg-black/5 px-2.5 py-1 text-[11px] text-black/60">Demo service</span>
      </header>
      <main className="mx-auto max-w-xl space-y-4 px-4 py-5">
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="mb-3 text-sm text-black/60">Prepared by your i-person. Check it and finish here.</p>
          <dl className="grid grid-cols-2 gap-2">
            {filters.map(([k, v]) => (
              <div key={k} className="rounded-xl border border-black/10 px-3 py-2">
                <dt className="text-[11px] uppercase tracking-wide text-black/50">{k}</dt>
                <dd className="font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
        <h2 className="px-1 text-sm font-semibold text-black/70">{results.length} results</h2>
        <ul className="space-y-3">
          {results.map((r) => (
            <li key={r.title} className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{r.title}</p>
                <p className="text-sm text-black/60">{r.sub}</p>
              </div>
              <div className="text-right">
                <p className="text-lg font-semibold">{r.price}</p>
                {r.tag && <p className="text-[11px] text-black/50">{r.tag}</p>}
              </div>
            </li>
          ))}
        </ul>
        <p className="px-1 text-center text-xs text-black/50">A demo page on i-persons.com with sample listings: nothing is booked or bought here.</p>
      </main>
    </div>
  );
}
