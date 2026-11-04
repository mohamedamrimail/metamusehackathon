import { useState } from 'react';
import { api } from '../api.ts';
import { Button } from '../components/ui.tsx';

// "Coming soon to <Country>" (Part C3), in the browser's language, with a waitlist that needs consent.

const T = {
  en: { title: (c: string) => `i-persons is coming soon to ${c}`, soon: 'i-persons is coming soon', line: 'Your personal digital twin: an avatar that knows you, speaks for you and acts for you — never without your yes.', email: 'Email', name: 'Name (optional)', consent: 'Notify me when i-persons launches in my country.', join: 'Notify me', done: 'Thanks! We’ll email you once, when we launch there.', invite: 'I have an invite code', share: 'Tell a friend: everyone who joins through your link brings i-persons to your country sooner.', copy: 'Copy link', copied: 'Copied' },
  fr: { title: (c: string) => `i-persons arrive bientôt en ${c}`, soon: 'i-persons arrive bientôt', line: 'Votre jumeau numérique personnel : un avatar qui vous connaît, parle et agit pour vous — jamais sans votre accord.', email: 'E-mail', name: 'Nom (facultatif)', consent: 'Prévenez-moi quand i-persons sera disponible dans mon pays.', join: 'Me prévenir', done: 'Merci ! Nous vous écrirons une fois, au lancement.', invite: 'J’ai un code d’invitation', share: 'Parlez-en : chaque inscription via votre lien rapproche le lancement dans votre pays.', copy: 'Copier le lien', copied: 'Copié' },
  de: { title: (c: string) => `i-persons kommt bald nach ${c}`, soon: 'i-persons kommt bald', line: 'Dein persönlicher digitaler Zwilling: ein Avatar, der dich kennt, für dich spricht und handelt — nie ohne dein Ja.', email: 'E-Mail', name: 'Name (optional)', consent: 'Benachrichtigt mich, wenn i-persons in meinem Land startet.', join: 'Benachrichtigen', done: 'Danke! Wir schreiben dir einmal, wenn es losgeht.', invite: 'Ich habe einen Einladungscode', share: 'Erzähl es weiter: Jede Anmeldung über deinen Link bringt i-persons schneller in dein Land.', copy: 'Link kopieren', copied: 'Kopiert' },
  ar: { title: (c: string) => `i-persons قريباً في ${c}`, soon: 'i-persons قريباً', line: 'توأمك الرقمي الشخصي: أفاتار يعرفك ويتحدث ويتصرف نيابةً عنك — دون أي خطوة بلا موافقتك.', email: 'البريد الإلكتروني', name: 'الاسم (اختياري)', consent: 'أعلموني عند إطلاق i-persons في بلدي.', join: 'أعلموني', done: 'شكراً! سنراسلك مرة واحدة عند الإطلاق.', invite: 'لدي رمز دعوة', share: 'شارك الرابط: كل تسجيل عبر رابطك يقرّب إطلاق i-persons في بلدك.', copy: 'نسخ الرابط', copied: 'تم النسخ' },
};

export function ComingSoon({ country, onInvite, invitedBy }: { country: string | null; onInvite(): void; invitedBy?: string }) {
  const lang = (navigator.language.slice(0, 2) as keyof typeof T) in T ? (navigator.language.slice(0, 2) as keyof typeof T) : 'en';
  const t = T[lang];
  const countryName = country ? new Intl.DisplayNames([lang], { type: 'region' }).of(country) ?? country : null;
  const [done, setDone] = useState(false);
  const [share, setShare] = useState<{ link: string; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} className="rim-glow grid min-h-full place-items-center px-4 py-10">
      <div className="w-full max-w-sm space-y-5 text-center">
        <img src="/favicon.svg" alt="" className="mx-auto h-14 w-14" />
        {invitedBy && <p className="text-sm text-rim" dir="auto">{invitedBy} invited you</p>}
        <h1 className="text-2xl font-semibold">{countryName ? t.title(countryName) : t.soon}</h1>
        <p className="text-muted">{t.line}</p>
        {done ? (
          <div className="space-y-3 rounded-xl border border-line p-4 text-sm">
            <p>{t.done}</p>
            {share && <>
              <p className="text-muted">{t.share}</p>
              <p className="break-all font-mono text-xs" dir="ltr">{share.link}</p>
              <div className="flex justify-center gap-2">
                <a href={`https://wa.me/?text=${encodeURIComponent(`${share.text} ${share.link}`)}`} target="_blank" rel="noreferrer" className="rounded-full bg-[#25D366] px-4 py-2 text-black">WhatsApp</a>
                <button type="button" className="rounded-full border border-line px-4 py-2" onClick={() => { void navigator.clipboard?.writeText(share.link).then(() => setCopied(true)); }}>{copied ? t.copied : t.copy}</button>
              </div>
            </>}
          </div>
        ) : (
          <form className="space-y-3 text-start" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            const ref = (() => { try { return localStorage.getItem('ip_wl') ?? undefined; } catch { return undefined; } })();
            await api<{ share_link: string; share_text: string }>('/waitlist', { body: { email: f.get('email'), name: f.get('name') || undefined, consent: true, ref } })
              .then((r) => { setShare({ link: r.share_link, text: r.share_text }); setDone(true); }).catch(() => {});
            setBusy(false);
          }}>
            <input name="email" type="email" required placeholder={t.email} aria-label={t.email} className="w-full rounded-xl border border-line bg-panel px-4 py-3 outline-none" />
            <input name="name" placeholder={t.name} aria-label={t.name} className="w-full rounded-xl border border-line bg-panel px-4 py-3 outline-none" />
            <label className="flex gap-2 text-sm text-muted"><input type="checkbox" required className="mt-0.5 accent-white" />{t.consent}</label>
            <Button disabled={busy} className="w-full py-3">{t.join}</Button>
          </form>
        )}
        <button type="button" onClick={onInvite} className="text-xs text-muted underline">{t.invite}</button>
      </div>
    </div>
  );
}
