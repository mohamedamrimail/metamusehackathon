import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function Button({ variant = 'primary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const v = variant === 'primary'
    ? 'bg-white text-black hover:bg-white/90'
    : variant === 'danger' ? 'border border-bad/40 text-bad hover:bg-bad/10' : 'border border-line text-white hover:border-white/40';
  return <button {...p} className={`rounded-full px-5 py-2.5 text-sm font-medium transition disabled:opacity-40 ${v} ${className}`} />;
}

export function Field({ label, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs uppercase tracking-wider text-muted">{label}</span>
      <input {...p} className="w-full rounded-xl border border-line bg-panel px-4 py-3 text-white outline-none placeholder:text-muted/60 focus:border-rim/60" />
    </label>
  );
}

export function Panel({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-panel p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Chip({ tone = 'muted', children }: { tone?: 'muted' | 'ok' | 'warn' | 'bad' | 'rim'; children: ReactNode }) {
  const t = { muted: 'text-muted border-line', ok: 'text-ok border-ok/30', warn: 'text-warn border-warn/30', bad: 'text-bad border-bad/30', rim: 'text-rim border-rim/30' }[tone];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${t}`}>{children}</span>;
}
