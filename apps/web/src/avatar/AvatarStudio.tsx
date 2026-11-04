import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { api, ApiError } from '../api.ts';
import { Speaker } from '../audio/speaker.ts';
import { Button, Panel } from '../components/ui.tsx';
import { useSession } from '../session.tsx';
import { Avatar } from './Avatar.tsx';
import type { Rig } from './LivingAvatar.tsx';
import { shareCard, shareOrDownload } from './share.ts';

type Mouth = { x: number; y: number; w: number };
interface Look { url: string; mouth: Mouth | null }
interface Style { id: string; label: string }

const IDEAS = ['Add sunglasses', 'Wear a navy suit', 'Beach at sunset behind me', 'Give me a red headscarf'];

/** "Your look": restyle the selfie, change the avatar in words, or start from a new photo. */
export function AvatarStudio() {
  const { user, iperson, refresh } = useSession();
  const id = iperson!.id;
  const [styles, setStyles] = useState<Style[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [looks, setLooks] = useState<Look[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const speaker = useRef(new Speaker());

  useEffect(() => {
    api<{ styles: Style[]; enabled: boolean }>('/avatar/styles').then((r) => { setStyles(r.styles); setEnabled(r.enabled); }).catch(() => {});
  }, []);

  const current: Look = { url: iperson!.avatarUrl ?? '', mouth: iperson!.avatarMeta?.mouth ?? null };
  const look = picked != null ? looks[picked] : undefined;
  const shown = look ?? current;

  const run = async (label: string, fn: () => Promise<Look[]>) => {
    setBusy(label);
    setError(null);
    try {
      const fresh = await fn();
      setLooks((l) => [...fresh, ...l].slice(0, 12));
      setPicked(0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const customize = (body: { style: string } | { instruction: string }, label: string) =>
    run(label, async () => [await api<Look>(`/ipersons/${id}/avatar/customize`, { body })]);

  const newSelfie = (file: File) => run('Creating your new looks', async () => {
    const form = new FormData();
    form.append('source', 'file'); // a file input, even with capture: needs a verified WhatsApp number
    form.append('file', file);
    const r = await api<{ options: string[]; mouths?: (Mouth | null)[] }>(`/ipersons/${id}/avatar/selfie`, { form });
    return r.options.map((url, i) => ({ url, mouth: r.mouths?.[i] ?? null }));
  });

  const moveMouth = (e: MouseEvent<HTMLImageElement>) => {
    if (picked == null) return;
    const r = e.currentTarget.getBoundingClientRect();
    const mouth = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, w: look?.mouth?.w ?? 0.16 };
    setLooks((l) => l.map((x, i) => (i === picked ? { ...x, mouth } : x)));
  };

  const use = async () => {
    if (!look) return;
    setBusy('Saving');
    // Consent is asked once per account ("This is me…"); after that the server doesn't need it again.
    if (!user?.selfie_consent && !confirm('This is me, and I agree my twin represents me.')) { setBusy(null); return; }
    await api(`/ipersons/${id}/avatar/select`, { body: { url: look.url, mouth: look.mouth ?? undefined, this_is_me: true } });
    await refresh();
    setLooks((l) => l.filter((_, i) => i !== picked));
    setPicked(null);
    setBusy(null);
  };

  return (
    <Panel title="Your look" aside={picked != null ? <span className="text-xs text-warn">Preview</span> : undefined}>
      <div className="flex flex-col items-center gap-3">
        <Avatar imageUrl={shown.url || null} mouth={shown.mouth ?? undefined} level={() => speaker.current.level()} state={busy ? 'thinking' : 'idle'} size={200} />
        {look && (
          <div className="flex w-full flex-col items-center gap-2">
            <img src={look.url} onClick={moveMouth} alt="New look" className="w-28 cursor-crosshair rounded-xl border border-line" />
            <p className="text-center text-xs text-muted">Tap the small picture to move the lips if they’re off.</p>
            <div className="flex w-full gap-2">
              <Button variant="ghost" className="px-3" onClick={() => { speaker.current.unlock(); speaker.current.speakText('Hi! How do I look?', 'en'); }}>Hear it</Button>
              <Button variant="ghost" className="px-3" onClick={() => setPicked(null)}>Keep current</Button>
              <Button className="flex-1" disabled={Boolean(busy)} onClick={use}>Use this</Button>
            </div>
          </div>
        )}
      </div>

      {looks.length > 0 && (
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {looks.map((l, i) => (
            <img key={l.url} src={l.url} alt={`Look ${i + 1}`} onClick={() => setPicked(i)}
              className={`h-14 w-14 shrink-0 cursor-pointer rounded-lg border-2 object-cover ${i === picked ? 'border-white' : 'border-line'}`} />
          ))}
        </div>
      )}

      {enabled && picked == null && <BringToLife ipersonId={id} avatarUrl={iperson!.avatarUrl} />}
      {picked == null && <SceneAndShare />}

      {enabled ? (
        <div className="mt-4 space-y-3">
          <div>
            <h3 className="mb-2 text-xs uppercase tracking-wider text-muted">Restyle my photo</h3>
            <div className="flex flex-wrap gap-2">
              {styles.map((s) => (
                <button key={s.id} type="button" disabled={Boolean(busy)} onClick={() => customize({ style: s.id }, s.label)}
                  className="rounded-full border border-line px-3 py-1.5 text-sm hover:border-white/40 disabled:opacity-40">{s.label}</button>
              ))}
            </div>
          </div>
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (instruction.trim()) void customize({ instruction }, 'Changing your look'); }}>
            <h3 className="text-xs uppercase tracking-wider text-muted">Change something</h3>
            <div className="flex gap-2">
              <input value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={300} placeholder="Add sunglasses…"
                className="min-w-0 flex-1 rounded-full border border-line bg-ink px-4 py-2 outline-none" />
              <Button variant="ghost" disabled={Boolean(busy) || instruction.trim().length < 3}>Go</Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {IDEAS.map((idea) => <button key={idea} type="button" onClick={() => setInstruction(idea)} className="text-xs text-muted underline-offset-2 hover:underline">{idea}</button>)}
            </div>
          </form>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted">New styles need the Meta image model, which isn’t connected right now. You can still use a new photo.</p>
      )}

      {user?.phone ? (
        <label className="mt-4 block cursor-pointer rounded-full border border-line py-2.5 text-center text-sm hover:border-white/40">
          New selfie
          <input type="file" accept="image/jpeg,image/png,image/webp" capture="user" className="hidden" disabled={Boolean(busy)}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void newSelfie(f); }} />
        </label>
      ) : (
        <p className="mt-4 text-center text-xs text-muted">Link your WhatsApp number (Connections, below) to use a new photo here.</p>
      )}

      {busy && <p className="mt-3 text-center text-sm text-muted">{busy}… about 10 seconds.</p>}
      {error && <p className="mt-3 text-center text-sm text-bad">{error}</p>}
    </Panel>
  );
}

/** A1: generate the pose set (blink, smile, wave…) for the current look. Shows the price first. */
function BringToLife({ ipersonId, avatarUrl }: { ipersonId: string; avatarUrl: string | null }) {
  const [info, setInfo] = useState<{ cost_usd: number; images: number; rig: { variants: Record<string, unknown> } } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    api<{ cost_usd: number; images: number; rig: { variants: Record<string, unknown> } }>(`/ipersons/${ipersonId}/avatar/life`).then(setInfo).catch(() => {});
  }, [ipersonId, avatarUrl]);
  if (!info) return null;
  const poses = Object.keys(info.rig.variants).length - 1;
  if (poses >= info.images) return <p className="mt-4 text-center text-xs text-muted">Your twin is fully alive: {poses} poses and expressions.</p>;
  return (
    <div className="mt-4 rounded-xl border border-line p-3 text-sm">
      <p className="mb-2 text-muted">Give this look blinks, smiles, waves and a thumbs up, so it reacts while you talk.</p>
      <Button className="w-full" disabled={busy} onClick={async () => {
        setBusy(true);
        setNote(null);
        try {
          const r = await api<{ missing: number }>(`/ipersons/${ipersonId}/avatar/life`, { method: 'POST' });
          setNote(r.missing ? `Done — ${r.missing} pose(s) didn’t work out; your twin works fine without them.` : 'Done! Go to Talk to see it.');
          setInfo(await api(`/ipersons/${ipersonId}/avatar/life`));
        } catch (err) {
          setNote(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
        } finally {
          setBusy(false);
        }
      }}>{busy ? 'Bringing it to life… about 30 seconds' : `Bring my twin to life: about $${info.cost_usd.toFixed(2)}`}</Button>
      {note && <p className="mt-2 text-center text-xs text-muted">{note}</p>}
    </div>
  );
}

/** A4: background scene behind the cut-out, Smart scenes, and the share card. */
function SceneAndShare() {
  const { iperson, refresh } = useSession();
  const id = iperson!.id;
  const meta = iperson!.avatarMeta ?? {};
  const [presets, setPresets] = useState<{ id: string; label: string }[]>([]);
  const [custom, setCustom] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { api<{ presets: { id: string; label: string }[]; custom: boolean }>('/avatar/scenes').then((r) => { setPresets(r.presets); setCustom(r.custom); }).catch(() => {}); }, []);

  const set = async (body: object) => {
    setBusy(true);
    setNote(null);
    try {
      await api(`/ipersons/${id}/avatar/scene`, { body });
      await refresh();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-2">
      <h3 className="text-xs uppercase tracking-wider text-muted">Scene</h3>
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button key={p.id} type="button" disabled={busy} onClick={() => void set({ preset: p.id })}
            className={`rounded-full border px-3 py-1.5 text-sm disabled:opacity-40 ${(meta.scene?.id ?? 'studio') === p.id ? 'border-white bg-white text-black' : 'border-line hover:border-white/40'}`}>{p.label}</button>
        ))}
      </div>
      {custom && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (prompt.trim().length >= 3) void set({ prompt }); }}>
          <input value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={200} placeholder="Describe a scene (uses AI credit)…"
            className="min-w-0 flex-1 rounded-full border border-line bg-ink px-4 py-2 text-sm outline-none" />
          <Button variant="ghost" disabled={busy || prompt.trim().length < 3}>Make</Button>
        </form>
      )}
      <label className="flex items-center gap-2 text-sm text-muted">
        <input type="checkbox" className="accent-white" checked={Boolean(meta.smartScenes)} onChange={(e) => void set({ smart: e.target.checked })} />
        Smart scenes (e.g. a beach while we talk about trips)
      </label>
      {meta.scene?.credit && <p className="text-xs text-muted">Scene photo: <a href={meta.scene.credit_url} target="_blank" rel="noreferrer" className="underline">{meta.scene.credit}</a></p>}
      <Button variant="ghost" className="w-full" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const r = await api<{ rig: Rig }>(`/ipersons/${id}/avatar/life`);
          await shareOrDownload(await shareCard(r.rig, meta.scene?.url, iperson!.displayName), iperson!.displayName);
        } catch {
          setNote('Couldn’t make the share card.');
        } finally {
          setBusy(false);
        }
      }}>Share my twin</Button>
      {busy && <p className="text-center text-xs text-muted">Working…</p>}
      {note && <p className="text-center text-xs text-bad">{note}</p>}
    </div>
  );
}

