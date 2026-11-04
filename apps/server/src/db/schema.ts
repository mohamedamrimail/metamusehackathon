import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, index, integer, jsonb, numeric, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const channelEnum = pgEnum('channel', ['web', 'whatsapp']);
export const riskEnum = pgEnum('risk', ['read', 'write', 'money']);
export const actionStatusEnum = pgEnum('action_status', [
  'proposed', 'confirmed', 'rejected', 'expired', 'done', 'failed',
]);
export const factCategoryEnum = pgEnum('fact_category', [
  'preference', 'routine', 'goal', 'constraint', 'contact',
]);
export const factSourceEnum = pgEnum('fact_source', ['onboarding', 'conversation', 'user_edit', 'mailbox', 'link']);
export const factVisibilityEnum = pgEnum('fact_visibility', ['private', 'public']);
export const connectionKindEnum = pgEnum('connection_kind', ['google_calendar', 'gmail', 'mcp', 'mail_microsoft', 'mail_google']);

export const genderEnum = pgEnum('gender', ['woman', 'man', 'unspecified']);
export const ageRangeEnum = pgEnum('age_range', ['18-24', '25-34', '35-44', '45-54', '55-64', '65+']);

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  phoneE164: text('phone_e164').unique(),
  name: text('name').notNull(),
  /** 'user' | 'judge' (signed up with a judges' code) | 'demo' (the seeded judge demo account). Only 'user' counts in metrics. */
  accountKind: text('account_kind').notNull().default('user'),
  /** Impact §1: opt-in weekly WhatsApp summary ("your i-person gave you back about 1 h 20 min this week"). */
  weeklySummary: boolean('weekly_summary').notNull().default(false),
  /** Growth §2: cohort from the invite code used, or the inviter's (personal invites also set referral). */
  cohort: text('cohort'),
  referral: boolean('referral').notNull().default(false),
  /** Twin chain challenge ("plan a coffee with a friend through your i-persons"). */
  chainStartedAt: timestamp('chain_started_at', { withTimezone: true }),
  chainCompletedAt: timestamp('chain_completed_at', { withTimezone: true }),
  /** Beta: set when a new account waits for approval by the team (lib/approval.ts); null = approved. */
  pendingApprovalAt: timestamp('pending_approval_at', { withTimezone: true }),
  /** Impact §4: redeemed a gift code (the "gift" tag in metrics). */
  giftAt: timestamp('gift_at', { withTimezone: true }),
  /** Impact §3: created as a WhatsApp guest (number proven by messaging us); converted once onboarded on the web. */
  guestAt: timestamp('guest_at', { withTimezone: true }),
  locale: text('locale').notNull().default('en'),
  timezone: text('timezone').notNull().default('Africa/Tunis'),
  // Profile from the first onboarding screen. Used only for avatar prompts, voice suggestions and
  // aggregate metrics: never shown publicly, never given to the agent.
  gender: genderEnum('gender'),
  ageRange: ageRangeEnum('age_range'),
  /** Version of the consent text the user accepted; behind CONSENT_VERSION means ask again. */
  consentVersion: integer('consent_version'),
  consentAt: timestamp('consent_at', { withTimezone: true }),
  /** ISO 3166-1 alpha-2 from the IP at sign-up, and from the phone number once WhatsApp is verified. */
  signupCountry: text('signup_country'),
  phoneCountry: text('phone_country'),
  /** WhatsApp verification (Phase 2): when the number was proven, and when the avatar welcome went out. */
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  welcomedAt: timestamp('welcomed_at', { withTimezone: true }),
  /** "This is me, and I agree my twin represents me." — given when a selfie becomes the avatar. */
  selfieConsentAt: timestamp('selfie_consent_at', { withTimezone: true }),
  /** Admin can suspend email sending (Phase 3b) or the whole account. */
  emailSuspendedAt: timestamp('email_suspended_at', { withTimezone: true }),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  /** The invite code that let this account past the country check, if any. */
  inviteCode: text('invite_code'),
  /** AI credit left, in micro-USD (1e-6). Can dip slightly below 0: calls are charged after they run. */
  aiCreditMicros: bigint('ai_credit_micros', { mode: 'number' }).notNull().default(0),
  /** Chosen in setup ("About you"): where the user lives and the currency prices are shown in. */
  country: text('country'),
  currency: text('currency'),
  /** First-run setup: the furthest step reached, and when it was finished (null = show setup). */
  setupStep: text('setup_step'),
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
  /** Contacts & twin-to-twin: 'contacts' (people with my verified email/number may see I'm on i-persons) | 'nobody'. */
  discoverability: text('discoverability').notNull().default('contacts'),
  /** Set when the account email was proven by a Google/Microsoft/Facebook sign-in (only then is it matchable). */
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const ipersons = pgTable('ipersons', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  avatarMouthUrl: text('avatar_mouth_url'),
  // Lip-sync placement on the avatar image: { mouth: { x, y, w } } in 0–1 image coordinates.
  avatarMeta: jsonb('avatar_meta'),
  // Public link (Phase 6): i-persons.com/@<handle>, off by default.
  handle: text('handle').unique(),
  publicEnabled: boolean('public_enabled').notNull().default(false),
  publicGreeting: text('public_greeting'),
  publicBio: text('public_bio'),
  /** What the twin may do with visitors: answer questions, take messages, propose meetings. */
  visitorAllow: jsonb('visitor_allow').notNull().default({ answer: true, messages: true, meetings: true }),
  openToJobs: boolean('open_to_jobs').notNull().default(false),
  /** Daily AI budget for visitor conversations, charged to the owner's credit (micro-USD). */
  visitorBudgetMicros: integer('visitor_budget_micros').notNull().default(500_000),
  /** The base avatar asset (personal or from the neutral library) whose poses the renderer uses. */
  avatarAssetId: uuid('avatar_asset_id'),
  voiceId: text('voice_id'),
  personaStyle: text('persona_style'),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
}, (t) => [index('ipersons_user_idx').on(t.userId)]);

export const profileFacts = pgTable('profile_facts', {
  id: id(),
  ipersonId: uuid('iperson_id').notNull().references(() => ipersons.id, { onDelete: 'cascade' }),
  category: factCategoryEnum('category').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  source: factSourceEnum('source').notNull().default('conversation'),
  /** Phase 6: only public facts reach visitors and partners; everything starts private. */
  visibility: factVisibilityEnum('visibility').notNull().default('private'),
  confidence: real('confidence').notNull().default(0.8),
  /**
   * 'active' | 'pending'. Learned in a turn that read outside content (web, emails, MCP, profile pages):
   * pending until the user keeps it, and never used in prompts, matching or public pages meanwhile.
   */
  status: text('status').notNull().default('active'),
  /** For pending items: the outside source read before it was learned ("web search"). */
  sourceHint: text('source_hint'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('profile_facts_key_uq').on(t.ipersonId, t.category, t.key, t.status)]);

export const conversations = pgTable('conversations', {
  id: id(),
  ipersonId: uuid('iperson_id').notNull().references(() => ipersons.id, { onDelete: 'cascade' }),
  channel: channelEnum('channel').notNull(),
  createdAt: createdAt(),
}, (t) => [index('conversations_iperson_idx').on(t.ipersonId, t.channel)]);

export const messages = pgTable('messages', {
  id: id(),
  // Strict insert order; created_at can tie within one millisecond.
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  // user | assistant | tool | notice (notice = runtime → model note, e.g. action results)
  role: text('role').notNull(),
  content: text('content').notNull().default(''),
  audioUrl: text('audio_url'),
  // assistant: the tool calls it made; tool: { tool_call_id }
  toolCalls: jsonb('tool_calls'),
  // HACKATHON: we use chat completions, so this holds the completion id rather than a Responses id.
  metaResponseId: text('meta_response_id'),
  createdAt: createdAt(),
}, (t) => [index('messages_conversation_idx').on(t.conversationId, t.seq)]);

export const connections = pgTable('connections', {
  id: id(),
  ipersonId: uuid('iperson_id').notNull().references(() => ipersons.id, { onDelete: 'cascade' }),
  kind: connectionKindEnum('kind').notNull(),
  config: jsonb('config').notNull().default({}),
  tokenEnc: text('token_enc'),
  enabled: integer('enabled').notNull().default(1),
  createdAt: createdAt(),
});

export const actions = pgTable('actions', {
  id: id(),
  ipersonId: uuid('iperson_id').notNull().references(() => ipersons.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  tool: text('tool').notNull(),
  args: jsonb('args').notNull(),
  risk: riskEnum('risk').notNull(),
  status: actionStatusEnum('status').notNull().default('proposed'),
  summary: text('summary').notNull(),
  amountCents: bigint('amount_cents', { mode: 'number' }),
  currency: text('currency'),
  result: jsonb('result'),
  confirmToken: text('confirm_token').notNull().unique(),
  /** Phase 3a provenance: proposed in a turn that read untrusted content (e.g. "web search"). */
  influencedBy: text('influenced_by'),
  /** Jury §3: set when the rules check couldn't run on this proposal; it then needs an explicit tap (no bare "yes"). */
  heldReason: text('held_reason'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('actions_iperson_idx').on(t.ipersonId, t.status)]);

export const wallets = pgTable('wallets', {
  id: id(),
  ipersonId: uuid('iperson_id').notNull().unique().references(() => ipersons.id, { onDelete: 'cascade' }),
  balanceCents: bigint('balance_cents', { mode: 'number' }).notNull().default(0),
  currency: text('currency').notNull().default('TND'),
  perActionLimitCents: bigint('per_action_limit_cents', { mode: 'number' }).notNull().default(5_000),
  monthlyBudgetCents: bigint('monthly_budget_cents', { mode: 'number' }).notNull().default(50_000),
  spentThisMonthCents: bigint('spent_this_month_cents', { mode: 'number' }).notNull().default(0),
  // Month the spent counter belongs to, 'YYYY-MM'; a new month resets it.
  spentMonth: text('spent_month'),
  createdAt: createdAt(),
});

export const paperPositions = pgTable('paper_positions', {
  id: id(),
  ipersonId: uuid('iperson_id').notNull().references(() => ipersons.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  qty: numeric('qty').notNull(),
  avgPrice: numeric('avg_price').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  pnl: numeric('pnl'),
  createdAt: createdAt(),
});

// HACKATHON: local demo calendar, used until Google Calendar OAuth is connected.
export const calendarEvents = pgTable('calendar_events', {
  id: id(),
  ipersonId: uuid('iperson_id').notNull().references(() => ipersons.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  location: text('location'),
  /** 'local' = booked here; 'outlook' / 'google' = imported from a connected calendar (refreshed on each sync). */
  source: text('source').notNull().default('local'),
  externalId: text('external_id'),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [index('calendar_events_range_idx').on(t.ipersonId, t.startsAt), uniqueIndex('calendar_events_external_uq').on(t.ipersonId, t.externalId)]);

// Opportunities already sent to the user, so a scan never repeats one.
export const notifications = pgTable('notifications', {
  id: id(),
  ipersonId: uuid('iperson_id').notNull().references(() => ipersons.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  payload: jsonb('payload').notNull(),
  channels: jsonb('channels').notNull().default([]),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('notifications_dedupe_uq').on(t.ipersonId, t.dedupeKey)]);

export const aiUsageKindEnum = pgEnum('ai_usage_kind', ['llm', 'stt', 'image', 'sam', 'tts']);

/** One row per metered Meta call: what it cost Meta, and the platform fee on top. */
export const aiUsage = pgTable('ai_usage', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: aiUsageKindEnum('kind').notNull(),
  model: text('model').notNull(),
  /** Tokens, images or audio seconds, as metered. */
  units: jsonb('units').notNull(),
  metaCostMicros: bigint('meta_cost_micros', { mode: 'number' }).notNull(),
  /** 'owner' (the user's own use) or 'visitor' (people talking to their public twin, within its daily budget). */
  scope: text('scope').notNull().default('owner'),
  feeMicros: bigint('fee_micros', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
}, (t) => [index('ai_usage_user_idx').on(t.userId, t.createdAt)]);

/**
 * Avatar images and their poses. Library rows (iperson_id null, library true) are the shared neutral
 * avatars; a personal twin's rows belong to its i-person. One row per pose variant of a look (`look_id`).
 */
export const avatarAssets = pgTable('avatar_assets', {
  id: id(),
  ipersonId: uuid('iperson_id').references(() => ipersons.id, { onDelete: 'cascade' }),
  library: boolean('library').notNull().default(false),
  /** Groups the pose variants of one look; the `base` row's id. */
  lookId: uuid('look_id'),
  style: text('style').notNull(),
  variant: text('variant').notNull().default('base'),
  gender: genderEnum('gender'),
  ageRange: ageRangeEnum('age_range'),
  imageUrl: text('image_url').notNull(),
  /** SAM output: { person?, face?, mouth?, eyes? } boxes (0–1) and mask PNG urls. */
  masks: jsonb('masks'),
  createdAt: createdAt(),
}, (t) => [index('avatar_assets_look_idx').on(t.lookId), index('avatar_assets_library_idx').on(t.library, t.gender, t.ageRange)]);

/** Runtime settings the admin changes without a restart (DB overrides .env). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** "Coming soon to your country": people to notify when it launches there. */
export const waitlist = pgTable('waitlist', {
  id: id(),
  email: text('email').notNull(),
  name: text('name'),
  country: text('country'),
  consentAt: timestamp('consent_at', { withTimezone: true }).notNull(),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  /** Impact §9: this person's own share link code, and the code of the link they came from (if any). */
  shareCode: text('share_code').unique(),
  referredBy: text('referred_by'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('waitlist_email_country_idx').on(t.email, t.country)]);

/** Admin-made codes that bypass the country check at sign-up (e.g. for hackathon judges). */
export const inviteCodes = pgTable('invite_codes', {
  code: text('code').primaryKey(),
  note: text('note'),
  maxUses: integer('max_uses').notNull().default(1),
  /** 'invite' | 'judge' | 'session': a judges' code lets people in from anywhere and marks their accounts as judges;
   *  a session code is a cohort code projected as a QR in a room (/s/<code>). */
  kind: text('kind').notNull().default('invite'),
  /** Growth §2: users who sign up with this code get this cohort label (e.g. sunday-friends, campus-pilot). */
  cohort: text('cohort'),
  uses: integer('uses').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/** Individual emails allowed from any country. */
export const bypassEmails = pgTable('bypass_emails', {
  email: text('email').primaryKey(),
  note: text('note'),
  createdAt: createdAt(),
});

/** Audit trail of admin changes (settings, codes, bypass list). */
export const adminLog = pgTable('admin_log', {
  id: id(),
  admin: text('admin').notNull(),
  action: text('action').notNull(),
  detail: jsonb('detail'),
  createdAt: createdAt(),
});

export const connectorCategoryEnum = pgEnum('connector_category', ['shopping', 'travel', 'jobs', 'productivity', 'other']);
export const connectorTypeEnum = pgEnum('connector_type', ['mail', 'mcp', 'upload', 'org']);

/**
 * The Service Store catalog (Phase B). HACKATHON: defined here from the addendum; the main prompt's
 * Phase 4 `connectors` table should be merged into this one when it lands.
 */
export const connectors = pgTable('connectors', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  type: connectorTypeEnum('type').notNull(),
  category: connectorCategoryEnum('category').notNull(),
  /** Square icon uploaded by the admin; none → a monogram tile. Brand logos are never drawn in code. */
  iconUrl: text('icon_url'),
  coverUrl: text('cover_url'),
  tagline: text('tagline').notNull(),
  longDescription: text('long_description').notNull().default(''),
  /** Short bullets: "Learn from your orders", … */
  capabilities: jsonb('capabilities').notNull().default([]),
  /** What it can access, in plain words, with the scopes users grant: [{ id, label, description, required }]. */
  scopes: jsonb('scopes').notNull().default([]),
  /** type mcp (Phase 4b): the remote server, an optional auth header (encrypted, never sent to browsers), allowed tools. */
  mcpUrl: text('mcp_url'),
  mcpAuthEnc: text('mcp_auth_enc'),
  toolAllowlist: jsonb('tool_allowlist').notNull().default([]),
  /** Mailbox sync: only emails from these sender domains are ever read (addendum 2). */
  senderDomains: jsonb('sender_domains').notNull().default([]),
  featured: boolean('featured').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(100),
  badge: text('badge'),
  verified: boolean('verified').notNull().default(false),
  live: boolean('live').notNull().default(true),
  createdAt: createdAt(),
});

/** A user's activated services and the scopes they granted. */
export const userServices = pgTable('user_services', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectorId: uuid('connector_id').notNull().references(() => connectors.id, { onDelete: 'cascade' }),
  grantedScopes: jsonb('granted_scopes').notNull().default([]),
  /** ok, or needs_attention with a reason ("Reconnect", "Forward your first email"). */
  health: text('health').notNull().default('ok'),
  statusLine: text('status_line'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('user_services_user_connector_idx').on(t.userId, t.connectorId)]);

// --- Mailbox learning (addendum 2). Raw emails are never stored: only these structured rows. ---

/**
 * People the user knows, from their address book and (opt-in) their personal email. Always private:
 * only the owner's own twin reads them (contacts_search), never visitors or partners.
 */
export const contacts = pgTable('contacts', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  /** Dedup key: lower-cased email, else "name:<name>". */
  key: text('key').notNull(),
  name: text('name').notNull(),
  emails: jsonb('emails').notNull().default([]),
  phones: jsonb('phones').notNull().default([]),
  birthday: text('birthday'),
  /** family | friend | colleague | client | business | other */
  relationship: text('relationship'),
  /** e.g. "brother", "wife", "manager at Yousoft-IT" */
  label: text('label'),
  notes: text('notes'),
  inAddressBook: boolean('in_address_book').notNull().default(false),
  mailsFrom: integer('mails_from').notNull().default(0),
  mailsTo: integer('mails_to').notNull().default(0),
  lastContactAt: timestamp('last_contact_at', { withTimezone: true }),
  /** When the twin learned about this person. */
  learnedAt: timestamp('learned_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Twin-to-twin (§1): whether this contact has a discoverable i-person. matched_user_id never leaves the server. */
  hasIperson: boolean('has_iperson').notNull().default(false),
  matchedUserId: uuid('matched_user_id').references(() => users.id, { onDelete: 'set null' }),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  /** null | 'email' | 'whatsapp': the channel of the last invite (details in `invites`). */
  inviteStatus: text('invite_status'),
}, (t) => [uniqueIndex('contacts_key_uq').on(t.userId, t.key)]);

/** One order line learned from a shop's emails (5b). Deduplicated by the provider's order reference. */
export const purchases = pgTable('purchases', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectorId: uuid('connector_id').references(() => connectors.id, { onDelete: 'set null' }),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  providerRef: text('provider_ref').notNull(),
  merchant: text('merchant').notNull(),
  title: text('title').notNull(),
  itemRef: text('item_ref'),
  category: text('category'),
  quantity: integer('quantity').notNull().default(1),
  amountCents: bigint('amount_cents', { mode: 'number' }),
  currency: text('currency'),
  orderedAt: timestamp('ordered_at', { withTimezone: true }).notNull(),
  deliveryAt: timestamp('delivery_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('purchases_user_ref_idx').on(t.userId, t.providerRef, t.title)]);

/** A stay or flight learned from confirmation emails (5b). */
export const bookings = pgTable('bookings', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectorId: uuid('connector_id').references(() => connectors.id, { onDelete: 'set null' }),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  providerRef: text('provider_ref').notNull(),
  kind: text('kind').notNull(), // hotel | flight
  title: text('title').notNull(),
  city: text('city'),
  country: text('country'),
  routeFrom: text('route_from'),
  routeTo: text('route_to'),
  stars: real('stars'),
  nights: integer('nights'),
  startAt: timestamp('start_at', { withTimezone: true }),
  endAt: timestamp('end_at', { withTimezone: true }),
  bookedAt: timestamp('booked_at', { withTimezone: true }),
  freeCancellation: boolean('free_cancellation'),
  amountCents: bigint('amount_cents', { mode: 'number' }),
  currency: text('currency'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('bookings_user_ref_idx').on(t.userId, t.providerRef)]);

/** Hashes of processed message ids, so nothing is read twice (the email itself is discarded). */
export const mailSeen = pgTable('mail_seen', {
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  hash: text('hash').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex('mail_seen_idx').on(t.connectionId, t.hash)]);

/** Insights computed in code from purchases and bookings (M4); phrased for the user. */
export const insights = pgTable('insights', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  /** Stable identity per pattern (e.g. "travel_pattern:munich"), so recomputing updates instead of duplicating. */
  key: text('key').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  data: jsonb('data').notNull().default({}),
  evidenceRefs: jsonb('evidence_refs').notNull().default([]),
  confidence: real('confidence').notNull().default(0.5),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('insights_user_key_idx').on(t.userId, t.key)]);

// --- Partner API (addendum 3, Part P). Partners talk to twins, never directly to user data. ---

export const partnerStatusEnum = pgEnum('partner_status', ['pending', 'active', 'suspended']);

/** "Become a partner" form submissions, reviewed by the admin. */
export const partnerApplications = pgTable('partner_applications', {
  id: id(),
  company: text('company').notNull(),
  website: text('website').notNull(),
  country: text('country').notNull(),
  contactName: text('contact_name').notNull(),
  email: text('email').notNull(),
  category: connectorCategoryEnum('category').notNull(),
  intendedUse: text('intended_use').notNull(),
  requestedScopes: jsonb('requested_scopes').notNull().default([]),
  logoUrl: text('logo_url'),
  status: text('status').notNull().default('pending'), // pending | approved | rejected
  reviewNote: text('review_note'),
  partnerId: uuid('partner_id'),
  createdAt: createdAt(),
});

export const partners = pgTable('partners', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  website: text('website'),
  status: partnerStatusEnum('status').notNull().default('active'),
  verified: boolean('verified').notNull().default(false),
  /** Run by the company that operates i-persons (Yousoft-IT): disclosed on its Store card, same API and limits as anyone. */
  operatorAffiliated: boolean('operator_affiliated').notNull().default(false),
  /** Partner scopes granted by the admin: offers:write, matches:read, twins:converse, requests:write, webhooks:manage. */
  scopes: jsonb('scopes').notNull().default([]),
  /** The partner's Service Store entry (users activate it there and grant user scopes). */
  connectorId: uuid('connector_id').references(() => connectors.id, { onDelete: 'set null' }),
  /** Approved manifest (P2); a pending one waits for admin review. */
  manifest: jsonb('manifest'),
  pendingManifest: jsonb('pending_manifest'),
  /** Requests per minute and new conversations/requests per offer per day. */
  rateLimitPerMin: integer('rate_limit_per_min').notNull().default(60),
  dailyCapPerOffer: integer('daily_cap_per_offer').notNull().default(50),
  createdAt: createdAt(),
});

/** People who can use the partner console / portal for a partner. */
export const partnerMembers = pgTable('partner_members', {
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('partner_members_idx').on(t.partnerId, t.userId)]);

/** OAuth client credentials; the secret is shown once and stored as a hash. */
export const partnerCredentials = pgTable('partner_credentials', {
  clientId: text('client_id').primaryKey(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  secretHash: text('secret_hash').notNull(),
  label: text('label'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/** Pairwise pseudonymous twin ids (HMAC of user + partner): two partners can't correlate one person. */
export const partnerTwins = pgTable('partner_twins', {
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  twinId: text('twin_id').notNull(),
  /** Paused or blocked by the user: no matching, no conversations, `user.revoked` fired. */
  blockedAt: timestamp('blocked_at', { withTimezone: true }),
}, (t) => [uniqueIndex('partner_twins_pk').on(t.partnerId, t.userId), uniqueIndex('partner_twins_twin').on(t.partnerId, t.twinId)]);

export const partnerOffers = pgTable('partner_offers', {
  id: id(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // job | deal | event | service
  title: text('title').notNull(),
  description: text('description').notNull(),
  requirements: jsonb('requirements').notNull().default({}),
  location: text('location'),
  remote: boolean('remote').notNull().default(false),
  countries: jsonb('countries').notNull().default([]),
  link: text('link'),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  status: text('status').notNull().default('open'), // open | closed
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const partnerMatches = pgTable('partner_matches', {
  id: id(),
  offerId: uuid('offer_id').notNull().references(() => partnerOffers.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  score: integer('score').notNull(),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('new'), // new | seen | dismissed
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('partner_matches_offer_user').on(t.offerId, t.userId)]);

export const partnerConversations = pgTable('partner_conversations', {
  id: id(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  offerId: uuid('offer_id').notNull().references(() => partnerOffers.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
});

/** Transcripts, visible to the user in Activity. */
export const partnerMessages = pgTable('partner_messages', {
  id: id(),
  conversationId: uuid('conversation_id').notNull().references(() => partnerConversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // partner | twin
  content: text('content').notNull(),
  createdAt: createdAt(),
});

/** A partner asks the user for something: always an approval card; nothing is shared before a yes. */
export const partnerRequests = pgTable('partner_requests', {
  id: id(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  offerId: uuid('offer_id').references(() => partnerOffers.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // share_cv | share_contact | schedule | custom
  payload: jsonb('payload').notNull().default({}),
  status: text('status').notNull().default('pending'), // pending | approved | declined | expired
  actionId: uuid('action_id'),
  /** What was shared on approval; returned once, then cleared. */
  shared: jsonb('shared'),
  sharedDeliveredAt: timestamp('shared_delivered_at', { withTimezone: true }),
  createdAt: createdAt(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});

export const partnerWebhooks = pgTable('partner_webhooks', {
  id: id(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  events: jsonb('events').notNull().default([]),
  createdAt: createdAt(),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: id(),
  webhookId: uuid('webhook_id').notNull().references(() => partnerWebhooks.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'), // pending | delivered | failed
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
  createdAt: createdAt(),
}, (t) => [index('webhook_deliveries_due').on(t.status, t.nextAttemptAt)]);

/** User reports about a partner (feeds the quality score). */
export const partnerReports = pgTable('partner_reports', {
  id: id(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  createdAt: createdAt(),
});

// --- The Yousoft recruiter portal's own storage (a client of the Partner API, like any partner app) ---
export const orgPipeline = pgTable('org_pipeline', {
  id: id(),
  partnerSlug: text('partner_slug').notNull(),
  offerId: uuid('offer_id').notNull(),
  twinId: text('twin_id').notNull(),
  stage: text('stage').notNull(), // matched | chatting | interview_requested | interview_confirmed | declined | expired | contact_shared
  requestId: uuid('request_id'),
  conversationId: uuid('conversation_id'),
  detail: jsonb('detail'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('org_pipeline_idx').on(t.partnerSlug, t.offerId, t.twinId)]);

// --- Public twin (Phase 6) ---

/** Someone talking to a public twin (no account needed). */
export const visitorConversations = pgTable('visitor_conversations', {
  id: id(),
  ipersonId: uuid('iperson_id').notNull().references(() => ipersons.id, { onDelete: 'cascade' }),
  visitorName: text('visitor_name').notNull(),
  visitorEmail: text('visitor_email'),
  visitorPhone: text('visitor_phone'),
  ipHash: text('ip_hash').notNull(),
  createdAt: createdAt(),
});

export const visitorMessages = pgTable('visitor_messages', {
  id: id(),
  conversationId: uuid('conversation_id').notNull().references(() => visitorConversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // visitor | twin | note (a message left for the owner)
  content: text('content').notNull(),
  createdAt: createdAt(),
});

/** "Report this i-person" (and other abuse reports), reviewed by admins. */
export const reports = pgTable('reports', {
  id: id(),
  ipersonId: uuid('iperson_id').references(() => ipersons.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  reporterContact: text('reporter_contact'),
  ipHash: text('ip_hash'),
  status: text('status').notNull().default('open'), // open | closed
  createdAt: createdAt(),
});

// --- First-run setup (warm-up): rules, links to learn from, preferred sources. ---

export const ruleKindEnum = pgEnum('rule_kind', ['do', 'dont']);
export const ruleSourceEnum = pgEnum('rule_source', ['user', 'onboarding', 'chat', 'learned', 'system']);

/** What the twin must / must never do. Every reply is checked against the active rules. */
export const ipersonRules = pgTable('iperson_rules', {
  id: id(),
  ipersonId: uuid('iperson_id').notNull().references(() => ipersons.id, { onDelete: 'cascade' }),
  kind: ruleKindEnum('kind').notNull(),
  text: text('text').notNull(),
  source: ruleSourceEnum('source').notNull().default('user'),
  /** Where it came from in words, e.g. the chat line that produced it. */
  sourceNote: text('source_note'),
  active: boolean('active').notNull().default(true),
  /** 'active' | 'pending': like facts, a rule learned after reading outside content waits for the user's keep. */
  status: text('status').notNull().default('active'),
  sourceHint: text('source_hint'),
  /** How often the checker had to correct a reply for this rule. */
  hits: integer('hits').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index('iperson_rules_iperson_idx').on(t.ipersonId)]);

/** Public pages the user pointed us to (website, LinkedIn, …); what was learned lands in profile_facts. */
export const profileLinks = pgTable('profile_links', {
  id: id(),
  ipersonId: uuid('iperson_id').notNull().references(() => ipersons.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  url: text('url').notNull(),
  /** pending → read | private (nothing public to read) | failed */
  status: text('status').notNull().default('pending'),
  summary: text('summary'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('profile_links_uq').on(t.ipersonId, t.url)]);

/** Preferred sources of insights and recommendations, ranked within each category (1 = first). */
export const sourcePrefs = pgTable('source_prefs', {
  id: id(),
  ipersonId: uuid('iperson_id').notNull().references(() => ipersons.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  provider: text('provider').notNull(),
  rank: integer('rank').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('source_prefs_uq').on(t.ipersonId, t.provider)]);

/**
 * One row per voice turn on Talk (jury prompt §8): how long each stage of the voice pipeline took, in ms.
 * stt = end of speech (audio.commit) → final transcript; first_model = transcript → first model response
 * (chat completions, not streamed); reply = transcript → final reply text (tool calls and rules check included);
 * tts = reply → first TTS audio byte sent; total = end of speech → first audio byte. Null = stage not reached.
 */
export const voiceLatency = pgTable('voice_latency', {
  id: id(),
  ipersonId: uuid('iperson_id').references(() => ipersons.id, { onDelete: 'set null' }),
  sttMs: integer('stt_ms'),
  firstModelMs: integer('first_model_ms'),
  replyMs: integer('reply_ms'),
  ttsMs: integer('tts_ms'),
  totalMs: integer('total_ms'),
  /** server (audio streamed) | fallback (server voice failed or no credit: browser spoke) | browser | none (nothing spoken) */
  ttsMode: text('tts_mode').notNull(),
  createdAt: createdAt(),
}, (t) => [index('voice_latency_created_idx').on(t.createdAt)]);

/** Jury §7: "How useful is your i-person?" after the 5th turn or on My twin. Quotable answers feed the README. */
export const feedback = pgTable('feedback', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** 1–5; null when the prompt was dismissed. */
  rating: integer('rating'),
  text: text('text'),
  /** "You may quote me with my first name". */
  quotable: boolean('quotable').notNull().default(false),
  /** Where it was asked: 'talk' (after the 5th turn) or 'twin'. */
  context: text('context').notNull(),
  createdAt: createdAt(),
}, (t) => [index('feedback_user_idx').on(t.userId)]);

/**
 * Impact §1 "time given back": a conservative estimate in minutes per completed, approved action type.
 * Admin edits add a new row (valid_from = now), so a change applies going forward only.
 */
export const timeEstimates = pgTable('time_estimates', {
  id: id(),
  /** calendar | email | travel_handoff | reorder_handoff | opportunity | twin_plan | partner_request | visitor_message */
  kind: text('kind').notNull(),
  minutes: real('minutes').notNull(),
  justification: text('justification').notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
}, (t) => [index('time_estimates_kind_idx').on(t.kind, t.validFrom)]);

// --- Contacts & twin-to-twin (docs/twin-to-twin.md) ---

/**
 * Keyed hashes (HMAC-SHA256 with a server secret) of each user's VERIFIED identifiers: proven emails and
 * the WhatsApp-verified number in E.164. Contacts are matched against these; plain values never live here.
 */
export const userIdentifiers = pgTable('user_identifiers', {
  kind: text('kind').notNull(), // email | phone
  hmac: text('hmac').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('user_identifiers_pk').on(t.kind, t.hmac), index('user_identifiers_user_idx').on(t.userId)]);

export const twinConnectionStatusEnum = pgEnum('twin_connection_status', ['pending', 'active', 'declined', 'revoked', 'blocked']);

/**
 * Two i-persons allowed to talk to each other (mutual consent). Each side grants scopes for its OWN data:
 * plan (on by default), availability (free/busy only), preferences (only the chosen facts), suggest.
 * One row per pair (either direction), enforced in code.
 */
export const twinConnections = pgTable('twin_connections', {
  id: id(),
  requesterId: uuid('requester_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  recipientId: uuid('recipient_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: twinConnectionStatusEnum('status').notNull().default('pending'),
  requesterScopes: jsonb('requester_scopes').notNull().default(['plan']),
  recipientScopes: jsonb('recipient_scopes').notNull().default(['plan']),
  /** Fact ids each side lets its twin share for planning (only used with the `preferences` scope). */
  requesterFactIds: jsonb('requester_fact_ids').notNull().default([]),
  recipientFactIds: jsonb('recipient_fact_ids').notNull().default([]),
  /** Who blocked (status blocked). A block also hides the blocker from the other side's contacts. */
  blockedBy: uuid('blocked_by'),
  /** 'contacts' (Connect twins) | 'invite' (offered after an accepted invite). */
  origin: text('origin').notNull().default('contacts'),
  /** The recipient's approval card, while one is open. */
  actionId: uuid('action_id'),
  createdAt: createdAt(),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('twin_connections_pair_uq').on(t.requesterId, t.recipientId), index('twin_connections_recipient_idx').on(t.recipientId)]);

/** Personal invites to contacts without an i-person (§3). One token per inviter + contact, valid 30 days. */
export const invites = pgTable('invites', {
  id: id(),
  inviterId: uuid('inviter_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  /** email | whatsapp (the last channel used) */
  channel: text('channel').notNull(),
  token: text('token').notNull().unique(),
  /** Keyed hash of the address an email invite went to (for "Don't send me invites again"). */
  emailHmac: text('email_hmac'),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedUserId: uuid('accepted_user_id').references(() => users.id, { onDelete: 'set null' }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  /** Referral credit paid to both sides (once, after the invitee verified WhatsApp). */
  rewardedAt: timestamp('rewarded_at', { withTimezone: true }),
  rewardMicros: bigint('reward_micros', { mode: 'number' }),
  createdAt: createdAt(),
}, (t) => [index('invites_inviter_idx').on(t.inviterId, t.sentAt), index('invites_contact_idx').on(t.contactId)]);

/**
 * Twin-to-twin planning (§5): a structured protocol between the twins, never free model-to-model chat.
 * status: draft | sent | negotiating | awaiting_confirmation | booked | declined | expired | cancelled
 */
export const planSessions = pgTable('plan_sessions', {
  id: id(),
  creatorId: uuid('creator_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // meeting | coffee | dinner | lunch | sport | walk | custom
  title: text('title'),
  durationMin: integer('duration_min').notNull(),
  /** Local dates (YYYY-MM-DD) in the creator's timezone, inclusive. */
  dateFrom: text('date_from').notNull(),
  dateTo: text('date_to').notNull(),
  timeOfDay: text('time_of_day').notNull().default('any'),
  area: text('area'),
  budget: text('budget'),
  /** Free text from the creator: shown to the others as quoted, untrusted text; never acted on. */
  note: text('note'),
  autoConfirm: boolean('auto_confirm').notNull().default(false),
  status: text('status').notNull().default('draft'),
  counterUsed: boolean('counter_used').notNull().default(false),
  bookedStart: timestamp('booked_start', { withTimezone: true }),
  bookedEnd: timestamp('booked_end', { withTimezone: true }),
  bookedPlaceId: uuid('booked_place_id'),
  /** Why it ended, in words (e.g. "no common time"). */
  endReason: text('end_reason'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('plan_sessions_creator_idx').on(t.creatorId, t.status)]);

/**
 * Everyone invited to a plan (not the creator). status: pending | asked | shared | invited | accepted |
 * declined | dropped | expired. chosen_slot_ids: the times they said yes to (one for 1:1, any for groups).
 */
export const planParticipants = pgTable('plan_participants', {
  id: id(),
  sessionId: uuid('session_id').notNull().references(() => planSessions.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'),
  chosenSlotIds: jsonb('chosen_slot_ids').notNull().default([]),
  chosenPlaceId: uuid('chosen_place_id'),
  /** Candidate starts their twin returned (ISO), before the creator's side filtered them. */
  candidates: jsonb('candidates').notNull().default([]),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('plan_participants_uq').on(t.sessionId, t.userId), index('plan_participants_user_idx').on(t.userId, t.status)]);

/** The options on the table: kind slot ({start,end}) or place ({name,address,url,reservation_url,partner}). */
export const planOptions = pgTable('plan_options', {
  id: id(),
  sessionId: uuid('session_id').notNull().references(() => planSessions.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  value: jsonb('value').notNull(),
  /** calendar | counter | web | partner */
  source: text('source').notNull(),
  link: text('link'),
  removed: boolean('removed').notNull().default(false),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index('plan_options_session_idx').on(t.sessionId)]);

/** Addresses that asked never to get invites again (keyed hash only), for all users. */
export const inviteSuppressions = pgTable('invite_suppressions', {
  emailHmac: text('email_hmac').primaryKey(),
  createdAt: createdAt(),
});

/** Impact §3: single-use, 15-minute links that sign a WhatsApp guest in on the web to finish their twin. */
export const magicLinks = pgTable('magic_links', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

// --- Impact §4: pricing interest, gifts and family plans (no payment provider yet: manual fulfilment) ---

/** "Plus — coming soon": one row per person who asked to be told. */
export const plusInterest = pgTable('plus_interest', {
  id: id(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  email: text('email').notNull().unique(),
  createdAt: createdAt(),
});

/** A gift of AI credit: pending_payment → paid (code made and sent) → redeemed; or cancelled. */
export const gifts = pgTable('gifts', {
  id: id(),
  buyerUserId: uuid('buyer_user_id').references(() => users.id, { onDelete: 'set null' }),
  buyerName: text('buyer_name').notNull(),
  /** Email or WhatsApp number of the buyer, to complete payment. */
  buyerContact: text('buyer_contact').notNull(),
  recipientName: text('recipient_name').notNull(),
  recipientEmail: text('recipient_email'),
  recipientPhone: text('recipient_phone'),
  amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
  message: text('message'),
  status: text('status').notNull().default('pending_payment'),
  code: text('code').unique(),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  redeemedBy: uuid('redeemed_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/** A family plan: the owner pays into one shared credit pool for up to FAMILY_MAX_MEMBERS members. */
export const familyGroups = pgTable('family_groups', {
  id: id(),
  ownerId: uuid('owner_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  poolMicros: bigint('pool_micros', { mode: 'number' }).notNull().default(0),
  createdAt: createdAt(),
});

/** One family per member. Members spend from the pool first (billing/credits.ts). */
export const familyMembers = pgTable('family_members', {
  groupId: uuid('group_id').notNull().references(() => familyGroups.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
});

export const familyInvites = pgTable('family_invites', {
  token: text('token').primaryKey(),
  groupId: uuid('group_id').notNull().references(() => familyGroups.id, { onDelete: 'cascade' }),
  /** Who it was meant for (shown to the owner only). */
  label: text('label'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/** Meta Ray-Ban Display glasses paired to an account (the /glasses web app). Only the token's sha256 is stored. */
export const glassesDevices = pgTable('glasses_devices', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  label: text('label').notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
});
