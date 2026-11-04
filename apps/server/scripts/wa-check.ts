// Prints the configured WhatsApp number's status, display-name review, quality rating,
// webhook subscription and template statuses (pnpm --filter @ipersons/server wa:check).
import { config } from '../src/config.ts';
import { TWIN_WA_TEMPLATES, WA_TEMPLATE_LANGS } from '../src/twins/wa-templates.ts';

const { WA_ACCESS_TOKEN: token, WA_PHONE_NUMBER_ID: phoneId, WA_WABA_ID: wabaId, WA_GRAPH_VERSION: v } = config;
if (!token || !phoneId) {
  console.error('WA_ACCESS_TOKEN and WA_PHONE_NUMBER_ID must be set in .env.');
  process.exit(1);
}

async function graph(path: string): Promise<any> {
  const res = await fetch(`https://graph.facebook.com/${v}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json() as any;
  if (body.error) return { error: `${body.error.code}/${body.error.error_subcode ?? '-'}: ${body.error.error_user_msg ?? body.error.message}` };
  return body;
}

const n = await graph(`${phoneId}?fields=display_phone_number,verified_name,name_status,new_name_status,status,code_verification_status,quality_rating,messaging_limit_tier,platform_type,account_mode`);
if (n.error) {
  console.error(`Phone ${phoneId}: ${n.error}`);
  process.exit(1);
}
console.log(`Number        ${n.display_phone_number} (id ${phoneId}, ${n.platform_type}, ${n.account_mode})`);
console.log(`Status        ${n.status}, code verification ${n.code_verification_status}`);
console.log(`Display name  "${n.verified_name}": ${n.name_status}${n.new_name_status && n.new_name_status !== 'NONE' ? ` (new name: ${n.new_name_status})` : ''}`);
console.log(`Quality       ${n.quality_rating}${n.messaging_limit_tier ? `, limit ${n.messaging_limit_tier}` : ''}`);
if (config.WA_PHONE_NUMBER && config.WA_PHONE_NUMBER.replace(/\D/g, '') !== String(n.display_phone_number).replace(/\D/g, '')) {
  console.log(`WARNING       WA_PHONE_NUMBER (${config.WA_PHONE_NUMBER}) does not match this number.`);
}

if (!wabaId) {
  console.log('\nWA_WABA_ID is not set: skipping webhook and template checks.');
  process.exit(0);
}
const numbers = await graph(`${wabaId}/phone_numbers?fields=id`);
const owned = numbers.data?.some((p: { id: string }) => p.id === phoneId);
console.log(`\nWABA          ${wabaId}${numbers.error ? `: ${numbers.error}` : owned ? ' (owns this number)' : ' — WARNING: does not list this number'}`);
const apps = await graph(`${wabaId}/subscribed_apps`);
console.log(`Webhook apps  ${apps.error ?? (apps.data?.map((a: any) => a.whatsapp_business_api_data?.name).join(', ') || 'none — run POST /<WABA>/subscribed_apps')}`);
const t = await graph(`${wabaId}/message_templates?fields=name,status,category,language&limit=100`);
if (t.error) console.log(`Templates     ${t.error}`);
else {
  console.log('Templates');
  for (const x of t.data ?? []) console.log(`  ${x.name.padEnd(28)} ${x.language.padEnd(6)} ${x.category.padEnd(15)} ${x.status}`);
  if (!t.data?.some((x: any) => x.name === config.WA_UPDATE_TEMPLATE)) console.log(`  WARNING: ${config.WA_UPDATE_TEMPLATE} (WA_UPDATE_TEMPLATE) is missing`);
  // Twin-to-twin templates (scripts/wa-templates.ts): one line per name with each language's status.
  console.log('Twin-to-twin templates');
  for (const def of TWIN_WA_TEMPLATES) {
    const st = WA_TEMPLATE_LANGS.map((l) => `${l}:${t.data?.find((x: any) => x.name === def.name && x.language === l)?.status ?? 'missing'}`);
    console.log(`  ${def.name.padEnd(28)} ${st.join('  ')}`);
  }
}
