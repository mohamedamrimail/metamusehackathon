// Checks META_API_KEY and lists the models it can use (find the Muse Image id here).
import OpenAI from 'openai';
import { config } from '../src/config.ts';

if (!config.META_API_KEY) {
  console.error('META_API_KEY is empty. Add it to .env at the repo root.');
  process.exit(1);
}
const client = new OpenAI({ apiKey: config.META_API_KEY, baseURL: config.META_BASE_URL });
const models = (await client.models.list()).data.map((m) => m.id).sort();
console.log(models.join('\n'));
const missing = [config.META_LLM_MODEL, config.META_SAM_MODEL].filter((m) => !models.includes(m));
console.log(missing.length ? `\nMISSING: ${missing.join(', ')}` : `\nOK: ${config.META_LLM_MODEL} and ${config.META_SAM_MODEL} are available.`);
