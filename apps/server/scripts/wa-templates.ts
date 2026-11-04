// Twin-to-twin WhatsApp templates (§8): prints what would be submitted; with --submit, creates them on
// the WhatsApp Business Account (WA_WABA_ID) for review by Meta. Run by a person, never by tests.
//   pnpm --filter @ipersons/server wa:templates            # dry run
//   pnpm --filter @ipersons/server wa:templates --submit   # submit (needs WA_ACCESS_TOKEN, WA_WABA_ID)
// After approval: Admin → Twins → tick "WhatsApp twin templates approved".
import { config } from '../src/config.ts';
import { templatePayload, TWIN_WA_TEMPLATES, WA_TEMPLATE_LANGS } from '../src/twins/wa-templates.ts';

const submit = process.argv.includes('--submit');
const payloads = TWIN_WA_TEMPLATES.flatMap((t) => WA_TEMPLATE_LANGS.map((l) => templatePayload(t, l)));

if (!submit) {
  for (const p of payloads) console.log(`${p.name.padEnd(22)} ${p.language}  ${p.components[0]!.text}`);
  console.log(`\n${payloads.length} templates. Dry run: add --submit to send them to Meta for review.`);
  process.exit(0);
}
const { WA_ACCESS_TOKEN: token, WA_WABA_ID: waba, WA_GRAPH_VERSION: v } = config;
if (!token || !waba) {
  console.error('WA_ACCESS_TOKEN and WA_WABA_ID must be set in .env.');
  process.exit(1);
}
// Skip what Meta already has (pending, approved or rejected), so a re-run only submits the missing ones.
const list = await fetch(`https://graph.facebook.com/${v}/${waba}/message_templates?fields=name,language,status&limit=250`, { headers: { Authorization: `Bearer ${token}` } });
const existing = new Map((((await list.json()) as { data?: { name: string; language: string; status: string }[] }).data ?? []).map((t) => [`${t.name}:${t.language}`, t.status]));
for (const p of payloads) {
  const had = existing.get(`${p.name}:${p.language}`);
  if (had) { console.log(`${p.name.padEnd(22)} ${p.language}  EXISTS (${had})`); continue; }
  const res = await fetch(`https://graph.facebook.com/${v}/${waba}/message_templates`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(p),
  });
  const body = await res.json() as { id?: string; status?: string; error?: { message?: string; error_user_msg?: string } };
  console.log(`${p.name.padEnd(22)} ${p.language}  ${res.ok ? `${body.status ?? 'submitted'} (${body.id})` : `FAILED: ${body.error?.error_user_msg ?? body.error?.message}`}`);
}
