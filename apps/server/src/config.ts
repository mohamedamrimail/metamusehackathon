import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// The .env lives at the repo root, shared by every app.
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const optional = z.string().optional().transform((v) => (v ? v : undefined));

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  /** Listen address: 127.0.0.1 behind nginx; 0.0.0.0 inside Docker. */
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().default('postgres://ip:ip@localhost:5432/ipersons'),
  TEST_DATABASE_URL: optional,
  /** Background jobs (BullMQ): opportunity scans, mailbox sync, nightly matching. Unset = those jobs are off. */
  REDIS_URL: optional,
  APP_URL: z.string().default('http://localhost:5173'),
  JWT_SECRET: optional,
  APP_ENCRYPTION_KEY: optional,
  /** Secret for the keyed hashes of verified emails/phones (contact matching). Defaults to one derived from APP_ENCRYPTION_KEY. */
  IDENTIFIER_HMAC_KEY: optional,
  /** Sender of contact invites; shown as "<Name> via i-persons". */
  INVITE_FROM: z.string().default('contact@i-persons.com'),

  META_API_KEY: optional,
  META_BASE_URL: z.string().default('https://api.meta.ai/v1'),
  META_LLM_MODEL: z.string().default('muse-spark-1.3'),
  // Muse Spark reasons before answering; 'low' keeps voice turns ~1 s and still picks tools well.
  META_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  META_STT_WS: z.string().default('wss://api.meta.ai/v1/asr/realtime'),
  META_STT_HTTP: z.string().default('https://api.meta.ai/v1/asr/transcribe'),
  META_IMAGE_MODEL: optional,
  META_SAM_MODEL: z.string().default('sam-3.1'),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(30_000),

  PEXELS_API_KEY: optional,
  /**
   * Country allowlist on/off. Off (the default) or NODE_ENV=development: every country is allowed.
   * Production sets ALLOWLIST_ENABLED=true; ALLOWED_COUNTRIES is then the default list (the admin setting overrides it).
   */
  ALLOWLIST_ENABLED: z.enum(['true', 'false']).default('false'),
  ALLOWED_COUNTRIES: z.string().default('DE,TN,DK,US'),
  /** Comma-separated emails with access to /admin. */
  ADMIN_EMAILS: z.string().default(''),
  /** Beta: new accounts wait for approval (the admin setting in the DB overrides it); requests go to APPROVAL_EMAIL. */
  BETA_APPROVAL: z.enum(['on', 'off']).default('off'),
  /** The "Meta AI calls" panel for demo accounts (Admin → Settings overrides it). */
  CALLS_PANEL: z.enum(['on', 'off']).default('on'),
  APPROVAL_EMAIL: z.string().default('contact@i-persons.com'),
  /**
   * Mailbox demo (hackathon): when MAIL_DEMO_MAILBOXES is set, only the accounts in MAIL_DEMO_USERS may
   * connect a mailbox, and only these mailbox addresses are accepted. Empty = open to every verified user.
   */
  MAIL_DEMO_USERS: z.string().default(''),
  MAIL_DEMO_MAILBOXES: z.string().default(''),
  MAXMIND_ACCOUNT_ID: optional,
  MAXMIND_LICENSE_KEY: optional,

  /** Impact §4: payment provider for gifts and plans. None is integrated yet: unset = requests wait as pending_payment. */
  PAYMENT_PROVIDER: optional,
  // smtp://user:pass@host:587 — without it, send_email lands in the demo outbox.
  SMTP_URL: optional,
  SMTP_FROM: z.string().default('i-persons <noreply@i-persons.com>'),
  UPLOAD_DIR: z.string().default(new URL('../uploads', import.meta.url).pathname),

  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  MS_CLIENT_ID: optional,
  MS_CLIENT_SECRET: optional,
  /** "Continue with Facebook" (Facebook Login on the Meta app); the button hides without them. */
  FACEBOOK_APP_ID: optional,
  FACEBOOK_APP_SECRET: optional,
  /** Facebook Login for Business: the login configuration (email + public_profile) used instead of scopes. */
  FACEBOOK_LOGIN_CONFIG_ID: optional,
  /** Incremental mailbox sync interval (addendum 2, M2.5). */
  /** The Yousoft recruiter portal's own Partner API credentials (scripts/seed-yousoft.ts). */
  YOUSOFT_CLIENT_ID: optional,
  YOUSOFT_CLIENT_SECRET: optional,
  /** Per-IP / per-user rate limits (Phase 3c); tests turn them off. */
  RATE_LIMITS: z.enum(['on', 'off']).default('on').transform((v) => v === 'on'),
  /** Jury §9: the mock wallet, orders and paper trading. Unset = off in production, on elsewhere (tests keep them). */
  SHOW_SIMULATIONS: z.enum(['on', 'off']).optional(),
  MAIL_SYNC_POLL_MINUTES: z.coerce.number().int().min(5).default(60),
  /** Public base URL, for OAuth redirect URIs. */
  PUBLIC_URL: z.string().default('https://i-persons.com'),
  WA_PHONE_NUMBER_ID: optional,
  /** WhatsApp Business Account that owns the number (templates, webhook subscription). */
  WA_WABA_ID: optional,
  WA_ACCESS_TOKEN: optional,
  WA_VERIFY_TOKEN: optional,
  WA_APP_SECRET: optional,
  WA_GRAPH_VERSION: z.string().default('v23.0'),
  /** The business number users message, e.g. +15553903087; shown on the linking screen. */
  WA_PHONE_NUMBER: optional,
  /** Approved template for messages outside the 24 h window, one {{1}} body parameter. */
  WA_UPDATE_TEMPLATE: z.string().default('iperson_update'),
  WA_TEMPLATE_LANG: z.string().default('en'),
  /** Hours between background opportunity scans; 0 disables the scheduler. */
  SCAN_EVERY_HOURS: z.coerce.number().default(1),
  // AI credit: every new user gets this much; each Meta call costs Meta's price plus the platform fee.
  AI_FREE_CREDIT_USD: z.coerce.number().min(0).default(5),
  /** Platform fee as a share of the Meta cost: 1 = the same amount again (2.50 Meta → 2.50 fee). */
  AI_PLATFORM_FEE_RATIO: z.coerce.number().min(0).default(1),
  // Meta list prices in USD (dev.meta.ai/docs/pricing-rate-limits, Oct 30). Reasoning tokens bill as output.
  PRICE_LLM_INPUT_PER_M: z.coerce.number().min(0).default(1.25),
  PRICE_LLM_CACHED_INPUT_PER_M: z.coerce.number().min(0).default(0.15),
  PRICE_LLM_OUTPUT_PER_M: z.coerce.number().min(0).default(4.25),
  PRICE_IMAGE: z.coerce.number().min(0).default(0.01),
  PRICE_SAM_IMAGE: z.coerce.number().min(0).default(0.0025),
  PRICE_STT_PER_HOUR: z.coerce.number().min(0).default(0.18),
});

export type Config = z.infer<typeof Env>;
// An empty value (`KEY=` in .env) means "not set": the default applies.
export const config: Config = Env.parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')));

/** The country allowlist applies only when ALLOWLIST_ENABLED=true and not in development. */
export const allowlistActive = () => config.ALLOWLIST_ENABLED === 'true' && config.NODE_ENV !== 'development';

/** The mock wallet, place_order, paper_trade and portfolio_status: off in production unless SHOW_SIMULATIONS=on. */
export const showSimulations = () => (config.SHOW_SIMULATIONS ? config.SHOW_SIMULATIONS === 'on' : config.NODE_ENV !== 'production');
export const SIMULATION_TOOLS = new Set(['wallet_status', 'place_order', 'paper_trade', 'portfolio_status']);
