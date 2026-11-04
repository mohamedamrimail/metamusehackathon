import { SETUP_STEPS, type SetupStep } from '@ipersons/shared';
import { getFeatures } from '../features.ts';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, type Iperson, type User } from '../api.ts';
import { Speaker } from '../audio/speaker.ts';
import { Avatar } from '../avatar/Avatar.tsx';
import { AvatarStudio } from '../avatar/AvatarStudio.tsx';
import { AboutYou, Gift, Interests, KnowMore, Rules, Sources, StepHeader, TwinName, Warmup } from '../components/Setup.tsx';
import { VerifyWhatsApp } from '../components/VerifyWhatsApp.tsx';
import { Button } from '../components/ui.tsx';
import { useSession } from '../session.tsx';

export function Onboarding() {
  const nav = useNavigate();
  const { user, iperson, refresh } = useSession();
  // Finished accounts go straight to Talk (login sends everyone here); setup's warm-up runs once, at the end of setup.
  const finished = Boolean(user?.onboarded && iperson?.avatarUrl && !user.consent_required);

  const [step, setStep] = useState<SetupStep>(() => firstStep(user, iperson));
  const go = useCallback((s: SetupStep) => {
    setStep(s);
    void api('/me/setup', { method: 'PATCH', body: { step: s } }).catch(() => {});
  }, []);
  const after = (s: SetupStep) => () => go(SETUP_STEPS[SETUP_STEPS.indexOf(s) + 1] ?? 'warmup');
  const verified = useCallback(() => { void refresh(); setStep((s) => (s === 'verify' ? 'gift' : s)); }, [refresh]);
  const at = SETUP_STEPS.indexOf(step);

  // Before any step renders: the warm-up step would otherwise start the greeting turn again.
  if (finished) return <Navigate to="/talk" replace />;
  return (
    <div className="rim-glow min-h-full px-4 py-8">
      <div className="mx-auto max-w-lg">
        <div className="mb-8 flex items-center justify-between gap-4">
          <span className="font-semibold tracking-tight">i-persons</span>
          <div className="flex gap-1">
            {SETUP_STEPS.map((s, k) => <span key={s} className={`h-1.5 w-5 rounded-full sm:w-7 ${k <= at ? 'bg-white' : 'bg-line'}`} />)}
          </div>
        </div>
        {step === 'verify' && <VerifyWhatsApp onVerified={verified} onSkip={user?.account_kind === 'judge' || noWhatsApp() ? () => go('gift') : undefined} />}
        {step === 'gift' && <Gift onNext={after('gift')} />}
        {step === 'about_you' && <AboutYou onNext={after('about_you')} />}
        {step === 'twin_name' && <TwinName onNext={after('twin_name')} />}
        {step === 'avatar' && <AvatarStep onNext={after('avatar')} />}
        {step === 'know_more' && <KnowMore onNext={after('know_more')} onLater={after('know_more')} />}
        {step === 'interests' && <Interests onNext={after('interests')} onLater={after('interests')} />}
        {step === 'rules' && <Rules onNext={after('rules')} onLater={after('rules')} />}
        {step === 'sources' && <Sources onNext={after('sources')} onLater={after('sources')} />}
        {step === 'warmup' && <Warmup onDone={async () => { await refresh(); nav('/talk'); }} />}
      </div>
    </div>
  );
}

/** Where to (re)start: the required steps first, then wherever the user left off. */
function firstStep(user: User | null, iperson: Iperson | null): SetupStep {
  // Judges (and everyone, when WhatsApp isn't configured on the server) may skip WhatsApp for the web experience;
  // features that need a verified number stay locked.
  const maySkip = user?.account_kind === 'judge' || noWhatsApp();
  if (!user?.verified && (!maySkip || !user?.setup_step || user.setup_step === 'verify')) return 'verify';
  const saved = (SETUP_STEPS as readonly string[]).includes(user.setup_step ?? '') ? user.setup_step as SetupStep : 'gift';
  const order = SETUP_STEPS.indexOf(saved);
  if (order > SETUP_STEPS.indexOf('about_you') && (user.consent_required || !user.country)) return 'about_you';
  if (order > SETUP_STEPS.indexOf('twin_name') && !iperson) return 'twin_name';
  if (order > SETUP_STEPS.indexOf('avatar') && !iperson?.avatarUrl) return 'avatar';
  return saved;
}

/** Selfie or neutral avatar, then the Avatar Studio to refine the look. */
function AvatarStep({ onNext }: { onNext(): void }) {
  const { iperson } = useSession();
  const [studio, setStudio] = useState(Boolean(iperson?.avatarUrl));
  if (!studio) return <Selfie onDone={() => setStudio(true)} />;
  return (
    <div className="space-y-6">
      <StepHeader title="Make it yours" sub="Try a style, or ask for a change in your own words (“add glasses”, “smile more”). Each new look uses a little AI credit." />
      <AvatarStudio />
      <div className="flex gap-3">
        <Button variant="ghost" onClick={() => setStudio(false)}>Start over</Button>
        <Button className="flex-1 py-3" onClick={onNext}>Looks good</Button>
      </div>
    </div>
  );
}

function Selfie({ onDone }: { onDone(): void }) {
  const { user, iperson, refresh } = useSession();
  const video = useRef<HTMLVideoElement>(null);
  const [neutral, setNeutral] = useState(false);
  const [thisIsMe, setThisIsMe] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  type Mouth = { x: number; y: number; w: number };
  const [options, setOptions] = useState<string[]>([]);
  const [mouths, setMouths] = useState<(Mouth | null)[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [mouth, setMouth] = useState<Mouth | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const speaker = useRef(new Speaker());

  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);

  const openCamera = async () => {
    setError(null);
    // In-app browsers (WhatsApp, Instagram…) on iPhone often have no camera API at all.
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser can’t open the camera here. Use “Use the phone camera” below, or open i-persons.com in Safari or Chrome.');
      return;
    }
    try {
      // `ideal` only: iPhones reject exact sizes they can't deliver; retry with no size at all.
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1024 }, height: { ideal: 1024 } }, audio: false })
        .catch((err: Error) => (err.name === 'OverconstrainedError' ? navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }) : Promise.reject(err)));
      setStream(s);
    } catch (err) {
      const denied = err instanceof Error && err.name === 'NotAllowedError';
      setError(denied
        ? 'Camera permission was denied. Allow it in your browser settings (iPhone: Settings → Safari → Camera), or use the phone camera below.'
        : 'Camera unavailable here. Use the phone camera below, or a neutral avatar.');
    }
  };

  // Attach the stream once the <video> exists. iPhone Safari needs muted + playsinline set before play().
  useEffect(() => {
    const v = video.current;
    if (!v || !stream) return;
    v.muted = true;
    v.setAttribute('playsinline', '');
    v.srcObject = stream;
    v.play().catch(() => {});
  }, [stream]);

  const upload = async (blob: Blob, source: 'camera' | 'file') => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('source', source); // before the file: the server reads it first
      form.append('file', blob, 'selfie.jpg');
      const r = await api<{ options: string[]; mouths?: (Mouth | null)[] }>(`/ipersons/${iperson!.id}/avatar/selfie`, { form });
      setOptions(r.options);
      setMouths(r.mouths ?? []);
      setPicked(r.options[0] ?? null);
      setMouth(r.mouths?.[0] ?? null);
      stream?.getTracks().forEach((t) => t.stop());
      setStream(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const capture = () => {
    const v = video.current!;
    // Not playing yet (iPhone can pause a fresh stream): nudge it and let the user tap again.
    if (!v.videoWidth) { void v.play().catch(() => {}); setError('The camera is still starting — tap Capture again.'); return; }
    setError(null);
    const side = Math.min(v.videoWidth, v.videoHeight);
    const c = document.createElement('canvas');
    c.width = c.height = Math.min(side, 1024);
    const g = c.getContext('2d')!;
    // Mirror like the preview, crop to a centered square.
    g.translate(c.width, 0);
    g.scale(-1, 1);
    g.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, c.width, c.height);
    c.toBlob((b) => b && upload(b, 'camera'), 'image/jpeg', 0.9);
  };

  const placeMouth = (e: MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMouth({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, w: 0.16 });
  };

  if (neutral) return <NeutralPicker onBack={() => setNeutral(false)} onDone={onDone} />;

  if (picked) {
    return (
      <div className="space-y-5">
        <h1 className="text-3xl font-semibold">{options.length > 1 ? 'Meet your i-person' : 'Tap your mouth'}</h1>
        <p className="text-muted">{mouth ? 'Pick the look you like. Tap the picture to move the lips if they’re off.' : 'Tap your mouth on the picture: that’s where your i-person’s lips move when it talks.'}</p>
        <div className="flex flex-wrap items-start justify-center gap-6">
          <img src={picked} onClick={placeMouth} className="w-56 cursor-crosshair rounded-2xl border border-line" alt="Your selfie" />
          <Avatar imageUrl={picked} mouth={mouth ?? undefined} level={() => speaker.current.level()} state="idle" size={224} />
        </div>
        {options.length > 1 && (
          <div className="flex gap-2">{options.map((o, i) => (
            <button key={o} type="button" onClick={() => { setPicked(o); setMouth(mouths[i] ?? null); }} className="text-center text-xs text-muted">
              <img src={o} alt={i === options.length - 1 ? 'Your photo' : `Style ${i + 1}`} className={`w-20 rounded-lg border-2 ${o === picked ? 'border-white' : 'border-line'}`} />
              {i === options.length - 1 ? 'Photo' : `Style ${i + 1}`}
            </button>
          ))}</div>
        )}
        <label className="flex gap-3 rounded-xl border border-line bg-panel p-3 text-sm">
          <input type="checkbox" checked={thisIsMe} onChange={(e) => setThisIsMe(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-white" />
          <span>This is me, and I agree my twin represents me.</span>
        </label>
        <div className="flex gap-3">
          <Button variant="ghost" onClick={() => { speaker.current.unlock(); speaker.current.speakText("Hi! I'm your i-person. Nice to meet you.", 'en'); }}>Hear it</Button>
          <Button variant="ghost" onClick={() => { setPicked(null); setOptions([]); setMouths([]); setMouth(null); }}>Retake</Button>
          <Button className="flex-1" disabled={busy || !thisIsMe} onClick={async () => {
            setBusy(true);
            await api(`/ipersons/${iperson!.id}/avatar/select`, { body: { url: picked, mouth: mouth ?? undefined, this_is_me: true } });
            await refresh();
            onDone();
          }}>Looks like me</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-semibold">Take a selfie</h1>
      <p className="text-muted">Face the camera in good light. Your i-person will look like you.</p>
      {stream ? (
        <div className="space-y-4">
          <video ref={video} autoPlay playsInline muted className="aspect-square w-full -scale-x-100 rounded-2xl border border-line object-cover" />
          <Button className="w-full py-3" disabled={busy} onClick={capture}>{busy ? 'Creating your i-person…' : 'Capture'}</Button>
        </div>
      ) : (
        <div className="grid gap-3">
          <Button className="py-3" onClick={openCamera}>Take a selfie</Button>
          {/* The phone's own camera app: always works on iPhone, even where the camera API doesn't. */}
          <label className="cursor-pointer rounded-full border border-line py-3 text-center text-sm hover:border-white/40">
            Use the phone camera
            <input type="file" accept="image/*" capture="user" className="hidden" onChange={(e) => e.target.files?.[0] && void squareJpeg(e.target.files[0]).then((b) => upload(b, user?.phone ? 'file' : 'camera')).catch(() => setError('Couldn’t read that photo. Try again.'))} />
          </label>
          {user?.phone ? (
            <label className="cursor-pointer rounded-full border border-line py-3 text-center text-sm hover:border-white/40">
              Upload a photo
              <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && void squareJpeg(e.target.files[0]).then((b) => upload(b, 'file')).catch(() => setError('Couldn’t read that photo. Try again.'))} />
            </label>
          ) : null}
          <Button variant="ghost" className="py-3" onClick={() => setNeutral(true)}>Skip, use a neutral avatar</Button>
          <p className="text-center text-xs text-muted">
            You can add a selfie later on My twin.{user?.phone ? '' : ' Uploading a photo file unlocks once your WhatsApp number is linked.'}
          </p>
        </div>
      )}
      {busy && !stream && <p className="text-muted">Creating your i-person… this takes about 15 seconds.</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}

interface LibraryAvatar { id: string; url: string }

/** No selfie: pick a ready-made neutral twin (instant and free), best matches for the profile first. */
function NeutralPicker({ onBack, onDone }: { onBack(): void; onDone(): void }) {
  const { user, iperson, refresh } = useSession();
  const [lib, setLib] = useState<{ matching: LibraryAvatar[]; others: LibraryAvatar[] } | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams({ gender: user?.gender ?? '', age_range: user?.age_range ?? '' });
    api<{ matching: LibraryAvatar[]; others: LibraryAvatar[] }>(`/avatar/library?${q}`).then(setLib).catch(() => setLib({ matching: [], others: [] }));
  }, [user?.gender, user?.age_range]);
  const shown = lib ? (all || !lib.matching.length ? [...lib.matching, ...lib.others] : lib.matching) : [];

  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-semibold">Choose your twin</h1>
      <p className="text-muted">A neutral avatar stands in for you. Public pages will say it’s a neutral avatar, and you can add a selfie any time.</p>
      {!lib && <p className="text-muted">Loading…</p>}
      <div className={`grid gap-3 ${all ? 'grid-cols-4' : 'grid-cols-2'}`}>
        {shown.map((a) => (
          <button key={a.id} type="button" disabled={Boolean(busy)} onClick={async () => {
            setBusy(a.id);
            await api(`/ipersons/${iperson!.id}/avatar/neutral`, { body: { asset_id: a.id } });
            await refresh();
            onDone();
          }} className={`overflow-hidden rounded-2xl border-2 ${busy === a.id ? 'border-white' : 'border-line hover:border-white/40'}`}>
            <img src={a.url} alt="Neutral avatar" className="aspect-square w-full object-cover" loading="lazy" />
          </button>
        ))}
      </div>
      <div className="flex gap-3">
        <Button variant="ghost" onClick={onBack}>Back to selfie</Button>
        {lib && lib.others.length > 0 && !all && <Button variant="ghost" className="flex-1" onClick={() => setAll(true)}>Show others</Button>}
      </div>
    </div>
  );
}

/**
 * Phone photos are large and iPhones may send HEIC: decode in the browser (which applies the EXIF
 * rotation), crop to a centered square of at most 1024 px, and upload a JPEG.
 */
async function squareJpeg(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = c.height = Math.min(side, 1024);
    c.getContext('2d')!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('encode failed'))), 'image/jpeg', 0.9));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** WhatsApp isn't configured on the server (GET /features, loaded before the app renders). */
const noWhatsApp = () => getFeatures()?.whatsapp === false;
