# i-persons

> Your i-person knows you, speaks for you, and acts for you — but never without your yes.

**TL;DR**
- **It acts for you:** a living, talking digital twin made from your selfie books meetings, sends emails and prepares hotel, flight and shopping hand-offs, and waits for your yes every time.
- **It learns you and speaks for you:** it remembers your life, follows your rules, and talks to visitors and recruiters at `i-persons.com/@you` without ever giving away what's private.
- **Everywhere you are:** on the web and as a home-screen app, on WhatsApp, and on **Meta Ray-Ban Display glasses**, where your twin floats in view and you approve with the Neural Band.
- **Built on Meta:** four Meta models (Muse Spark, Muse Image, Muse Voice Transcribe, SAM 3.1), WhatsApp as the Meta channel, and Meta Ray-Ban Display glasses.

## Quick start (run it on your machine)

You need **Docker** with **Compose v2.24+** (Docker Desktop, or Docker Engine with the compose plugin) and a
**Meta Model API key**. Nothing else.

```bash
git clone https://github.com/mohamedamrimail/metamusehackathon.git
cd metamusehackathon
cp .env.example .env          # then open .env and set META_API_KEY=<your key>
docker compose up --build     # first build takes a few minutes
```

Open **http://localhost:3000** and log in with one of the demo accounts. They all use the password **`ipersons-demo`**:

| Account | Who | Try |
| --- | --- | --- |
| `adam@i-persons.com` | Adam, engineer in Berlin | My twin → **Your look → New selfie** (Muse Image + SAM 3.1), then *"Book Thursday at ten with the supplier"* |
| `sara@i-persons.com` | Sara, Adam and Hana's daughter | hold the mic: *"Plan a coffee with my mom next week"* |
| `hana@i-persons.com` | Hana, Sara's mother | approve Sara's coffee plan; My twin: insights, rules, time given back |
| `giga@i-persons.com` | Giga, Adam's mother, 81, Sfax | talk to her in Tunisian Arabic |
| `demo@i-persons.test` | Alex, a general demo | *"Am I free tomorrow afternoon?"* |

The family's twins know each other: Sara's coffee plan goes to Hana's twin, they compare free times, and after both say
yes it lands in both calendars. Use a second browser window (or an incognito one) to be Sara and Hana at the same time.
On demo accounts, Talk shows the example sentences as buttons, and a **Meta AI calls** panel on the right shows every
live Meta model call with its latency. Demo accounts never send real email or WhatsApp messages (shown as *simulated*).
You can also sign up with any email: every country is allowed and no approval is needed locally.

What happens on `docker compose up`:

- Postgres 16 and Redis 7 start inside Docker. No ports are opened on your machine except the app's.
- The app container creates its secrets (`JWT_SECRET`, `APP_ENCRYPTION_KEY`) once, applies the database migrations,
  imports a starter set of 18 neutral avatars (12 MB, in `apps/server/starter-avatars/`) and creates the demo accounts.
  All of this is idempotent: later starts skip what exists. Data lives in the `pgdata` and `ipersons-data` volumes.
- At startup the server checks `META_API_KEY` against Meta's `/models` endpoint and prints the result in a box. If the
  key is missing or rejected, the app **keeps running in demo mode** (a simple rule-based stand-in, no Meta calls),
  with a **DEMO MODE** banner on every page.

Useful commands: `docker compose logs -f app` (server log), `docker compose down` (stop), `docker compose down -v`
(stop and delete all data), `APP_PORT=3100 docker compose up` (another port).

<details><summary>Without Docker (Node 22 + pnpm + your own Postgres)</summary>

```bash
nvm use                                   # Node 22 (.nvmrc)
corepack enable                           # pnpm 10 (packageManager in package.json)
pnpm install
cp .env.example .env                      # META_API_KEY, and DATABASE_URL=postgres://user:pass@localhost:5432/ipersons
pnpm start                                # builds the web app, migrates, seeds the demo user, serves http://localhost:3000
```

`REDIS_URL` is optional (background scans and mailbox sync are off without it). For development with hot reload:
`pnpm dev:server` (API on :3000) and `pnpm dev:web` (web on :5173, proxies `/api` and `/ws`). Tests: `pnpm typecheck &&
pnpm test` with `TEST_DATABASE_URL` set to a `*_test` database.
</details>

### Configuration

Every setting is listed and commented in [.env.example](.env.example), marked REQUIRED or OPTIONAL. **Only `META_API_KEY`
is required.** WhatsApp, Meta Ray-Ban Display glasses, Google / Microsoft / Facebook sign-in, the mailbox, real email
(SMTP) and stock-photo scenes are all optional: without their settings the app starts normally and those features say
**"not configured"** (setup lets you skip the WhatsApp step; emails land in the Activity outbox).

### Troubleshooting

| Problem | Fix |
| --- | --- |
| **DEMO MODE** banner, or `Meta Model API: DEMO MODE` in the log | `META_API_KEY` is empty or was rejected (HTTP 401/403). Put the key in `.env` (no quotes, no spaces) and run `docker compose up -d --force-recreate app`. |
| `could not check the key` in the log | Meta's API wasn't reachable at startup; the app carries on with the key. Check your network or proxy. |
| `port is already allocated` / `EADDRINUSE` | Port 3000 is taken: `APP_PORT=3100 docker compose up` and open http://localhost:3100. |
| The microphone or camera doesn't work | Browsers allow them only on `http://localhost` or HTTPS: open `localhost`, not your machine's IP. Allow the permission in the address bar (Chrome: the icon left of the URL; Safari: Settings → Websites → Microphone/Camera) and on macOS also in System Settings → Privacy & Security. |
| The twin doesn't speak | Speech output is the browser's `speechSynthesis`. Tap the page once (browsers need a gesture before speaking), check the tab isn't muted, and that your OS has a voice for the language (en, fr, de, ar). Without `speechSynthesis` replies are shown as text only. |
| Login fails right after `docker compose up` | Wait for `i-persons is running` in `docker compose logs app` (migrations and the seed run first). |
| Start from scratch | `docker compose down -v && docker compose up --build` |

## Try it online

**Live app:** https://i-persons.com (in beta: new accounts are approved by our team first).

- 👤 **Demo accounts**, ready to use, password **`ipersons-demo`**: `adam@i-persons.com`, `sara@i-persons.com`,
  `hana@i-persons.com`, `giga@i-persons.com` (the same family and examples as in the table above). They are shared by
  everyone who tries them, so you may see other people's conversations; they hold sample data about made-up people and
  never send real email or WhatsApp messages.
- 🎟 **Your own twin, without the beta wait and from any country:** https://i-persons.com/?invite=TRY-IPERSONS
  (you can skip WhatsApp verification; features that need a verified number stay locked and say so).
- 💬 **Talk to someone's twin as a visitor:** https://i-persons.com/@hana or https://i-persons.com/@adam
- 🧑‍💼 **Recruiter portal (Partner API client):** https://i-persons.com/org/yousoft
- Every account gets **$5 of AI credit**.

## 1. It acts for you

- **Voice, push-to-talk.** Hold the mic and talk (or tap to start, tap to send): Muse Voice Transcribe hears you live, and the twin answers out loud with your browser's built-in voice (`speechSynthesis`, in the reply's language). Pressing the mic interrupts it. It never reads web addresses aloud.
- **Approvals, always.** Booking calendar events, sending emails and partner or visitor requests all become **Approve / Decline cards** on the web and on WhatsApp. Nothing happens in your name before you say yes.
- **Real hand-offs.** "Find me a hotel in Munich like last time" leads to real options (Muse Spark web search) and a card. On your yes, a **prefilled link** (already filtered to your usual 4-star, free cancellation) arrives on WhatsApp and you finish on the site. The same works for flights and shopping reorders. It never books or buys by itself.
- **WhatsApp.** The same twin on WhatsApp: text, voice notes, pictures with suggestions, and Approve / Decline buttons.
- **On Meta Ray-Ban Display glasses.** Pair your glasses from My twin → Glasses (one QR code). Your twin's cut-out floats in the in-lens display (black is see-through), blinks and says its replies; waiting cards show **Approve / Decline** for the Neural Band, and you ask by typing or dictating. Glasses web apps have no microphone yet, so voice stays on the phone and WhatsApp.
- **Living avatar.** Made from your selfie with Muse Image (or a neutral avatar from a library of 72). SAM 3.1 cuts it out and finds the face, eyes and mouth; it breathes, blinks, lip-syncs, gestures and changes mood with each reply. Add it to your phone's home screen with its face as the icon.

## 2. It learns you

- **Memory you control.** It remembers routines, goals and preferences; every fact is on My twin, editable, deletable, private by default.
- **Your rules.** "Never book anything on Sunday mornings": checked on every reply and on every action.
- **Know more about you, without scraping.** Paste your LinkedIn About and experience or upload LinkedIn's own profile PDF; point it to a site you own (one page, robots.txt respected). Social networks are never fetched.
- **Mailbox insights.** Connect Outlook or Gmail read-only: it reads only emails from services you activated in the Service Store, from the last 1–3 months, turns each into orders, stays and flights with Muse Spark, and throws the email away. Insights are computed in code: "You book hotels about 7 days ahead", "Coffee capsules about every 5 weeks".
- **People you know** (three separate opt-ins, all off by default):
  - **Learn who I know** has its own switch per mailbox and its own explanation screen. While reading, the twin sees the names and addresses of senders and recipients, the subjects and the short preview Outlook or Gmail shows; never whole emails. It keeps only, per person: the name, the email address, the relationship and role it worked out, a one-line note in its own words (at most 100 characters, no quoted email text), and the date it learned it. Subjects and previews are never stored.
  - **Import my contacts** and **Import my calendar** are separate switches. Each asks Microsoft or Google for its permission only when you switch it on; connecting a mailbox for orders and bookings asks for mail only.
  - **Never shared:** contacts never reach public pages, visitors, partners, matching or background scans. The twin uses them only when you ask about your own people ("who are my friends?").
  - **Deletion:** switching one off offers "Delete what was learned"; disconnecting a mailbox deletes the people and events learned from it. Verified on a real mailbox.

## 3. It speaks for you

- **Your public twin** at `i-persons.com/@you`. Visitors chat without an account; it says it isn't you and only knows the facts you made **public**. They can leave a message or ask for a meeting, your email or your CV; each request is an approval card for you. On a yes you get a calendar event and the visitor gets a real email. Visitor chats use your AI credit up to a daily budget you set.
- **My twin talks to your twin.** The Contacts page shows which of your contacts already have an i-person. Invite the others (by email, or from your own WhatsApp), connect with the ones who do, and let your twins plan a coffee, dinner or meeting: they find times that suit both of you, propose real places, and put it in both calendars. **Consent in three sentences:** twins connect only when both people say yes, and either can disconnect or block at any time. A twin shares only free/busy times and the preferences its owner ticked, never calendar details, private facts or contacts. Nothing is booked until both people have said yes. No address book needed: **find someone on i-persons** by the WhatsApp number or email they verified (only if they let contacts find them) or by a public twin's name or @handle, and connected twins always appear in both people's Contacts. Details: [docs/twin-to-twin.md](docs/twin-to-twin.md).
- **Partners and recruiters (Partner API).** Companies apply on `/developers`; admins approve them with scopes. Offers are matched only to people who activated the partner in the Store, using public facts only and never gender or age. Partners see a **pseudonymous id per partner**, can ask the twin questions, and send requests the person approves; shared data reaches them once, through signed webhooks. Partners without developers use the no-code **partner console** (`/console/<slug>`), which calls the same public API. Quick start: [docs/partners/quick-start.md](docs/partners/quick-start.md).
- **Disclosure:** Yousoft-IT both operates i-persons and is its first partner (recruiting). Its recruiter portal (`/org/yousoft`) uses only the public Partner API, with the same rules and limits as any partner and no private access; its Store card says "Operated by the i-persons team".

## More

- **Service Store:** activate services with plain-words permissions (including remote MCP servers, tested on save, with an encrypted auth header and a tool allowlist).
- **Admin panel (`/admin`):** users, credit top-ups with a reason, suspensions, reports, metrics with CSV export, voice latency, feedback, runtime settings, countries and invite codes, connectors and partners.
- **AI credit:** every Meta model call is metered at Meta's price plus a platform fee and shown on My twin. New accounts get $5.
- **Pricing, gifts and family (`/pricing`):** Free, Plus (coming soon, interest recorded), a **Family plan** (one person pays a shared credit pool for up to 5 members and sees only their spend, never their conversations) and **Gift a twin** (credit for someone else, by email or from your own WhatsApp). Payment is arranged by hand for now.
- **Waitlist:** outside the open countries, people join a waitlist and get a share link; admin sees demand by country and day.

## Trust and safety

- **The approval gate is the hard boundary.** Every tool is `read`, `write` or `money`. Write and money tools only create a proposal; nothing runs until the person approves. A bare "yes" works when exactly one proposal is waiting. Confirmations are single-use and expire after 10 minutes (72 hours for partner and visitor requests). Every proposal and outcome stays in the Activity log.
- **Your rules.** Your rules are checked on every reply, and always on actions: if the check can't run, the action waits for an explicit tap. A proposal that breaks a rule is never shown; the twin says which rule stopped it.
- **Prompt injection.** Everything from outside reaches the model inside delimited `<untrusted>` blocks: web search results, MCP results, email-derived data, visitors and partners. Fake delimiters are defused. A proposal made after reading outside content is flagged on its card: "Suggested after reading web search."
- **Memory can't be planted.** A fact or rule the twin learns right after reading outside content (web, emails, connected services, profile pages) is held until you tap Keep.
- **Beta approval.** i-persons is in beta: every new account is reviewed by the team before it can be used (existing accounts, invited and demo accounts are never held). The country gate applies to new sign-ups only; existing accounts work from anywhere.
- **Verification.** Every twin belongs to a reachable person: `VERIFY <code>` on WhatsApp, one account per number. Sending email, connecting services, public links and appearing to partners need a verified number. A selfie-based twin needs an explicit "This is me" consent.
- **Email limits.** Verified senders only; 5 per hour and 20 per day, at most 5 recipients; every email is signed "— sent by <Name>'s i-person" and has a report-abuse link. Made-up addresses (`example.com`, `*.test` …) are never emailed.
- **Privacy.** No social scraping; people you know are opt-in and never shared; raw emails are never kept; tokens are encrypted; gender and age never reach the agent or partners; "Delete my account" erases everything.

## Built on Meta

**All AI model calls go to Meta models**, through the Meta Model API (`META_BASE_URL`, OpenAI-compatible; the `openai`
npm package is only the client library). Speech output uses the browser's `speechSynthesis`, which is not an AI model call.

| Meta model | Purpose | Code |
| --- | --- | --- |
| Muse Spark (`muse-spark-1.3`) | The agent and its tools, the rules check on replies and actions, the visitor and partner twins, extraction from emails, people labels, matching, web search | [meta/llm.ts](apps/server/src/meta/llm.ts), used by [agent/runtime.ts](apps/server/src/agent/runtime.ts), [agent/rules.ts](apps/server/src/agent/rules.ts), [mail/extract.ts](apps/server/src/mail/extract.ts), [public/visitor.ts](apps/server/src/public/visitor.ts) |
| Muse Voice Transcribe (`muse-voice-transcribe-1.0`) | Live speech-to-text on Talk (realtime WebSocket), WhatsApp voice notes | [meta/stt.ts](apps/server/src/meta/stt.ts), [channels/web.ts](apps/server/src/channels/web.ts) |
| Muse Image (`muse-image-1.0`) | Avatars from selfies, the neutral library, poses, style presets, edits, scenes | [meta/image.ts](apps/server/src/meta/image.ts), [http/ipersons.ts](apps/server/src/http/ipersons.ts), [scripts/gen-neutral-avatars.ts](apps/server/scripts/gen-neutral-avatars.ts) |
| SAM 3.1 (`sam-3.1`) | Person cut-out, face, eyes and mouth boxes for the living avatar | [meta/image.ts](apps/server/src/meta/image.ts) (`segment`, `analyzeAvatar`) |

Meta platforms (optional): **WhatsApp Cloud API** for verification, chat, voice notes, pictures, approval buttons and
alerts ([channels/whatsapp.ts](apps/server/src/channels/whatsapp.ts)); **Meta Ray-Ban Display** Web Apps for the twin in
the in-lens display, with approvals on the Neural Band ([http/glasses.ts](apps/server/src/http/glasses.ts)); **Facebook Login**.
What we verified against the live API is in [docs/meta-api-notes.md](docs/meta-api-notes.md).

**Browser and OS features (no AI model calls):**

| Feature | Used for |
| --- | --- |
| `speechSynthesis` | The twin's spoken replies, with a voice that matches the reply's language (en, fr, de, ar) ([audio/speaker.ts](apps/web/src/audio/speaker.ts)) |
| Microphone (`getUserMedia`) | Push-to-talk: while you hold the mic, the browser streams 16 kHz PCM to Muse Voice Transcribe ([audio/mic.ts](apps/web/src/audio/mic.ts)) |
| Camera (`getUserMedia`) | Taking the selfie for your avatar |
| `SpeechRecognition` | Speech-to-text **in demo mode only** (no Meta key) |
| PixiJS / WebGL | The living avatar's mesh animation ([avatar/LivingAvatar.tsx](apps/web/src/avatar/LivingAvatar.tsx)) |
| Web App Manifest | Adding your twin to the phone's home screen, with its face as the icon |

Every outside service, what it's for and what happens without it: [docs/third-party-services.md](docs/third-party-services.md).

## Traction

_As of 1 November 2026, from Admin → Metrics. Real users only: invited reviewers, demo accounts and the team are excluded. We opened to the public days before submission and are in beta (new accounts are approved by hand). Regenerate with `pnpm --filter @ipersons/server metrics:summary`._

| Metric | Value |
| --- | --- |
| Sign-ups / WhatsApp-verified | 2 / 2 |
| Active users / active on 2+ days | 1 / 0 |
| Conversation turns / voice minutes | 2 / 0.2 |
| Actions proposed / approved / declined | 0 / 0 / 0 |
| Public-twin visitor conversations / partner requests | 0 / 0 |
| AI cost per active user per day (median) | $0.07 |

## Quality

We measure the twin against the real Muse Spark, not mocks. Full results, method and every case: [docs/eval-results.md](docs/eval-results.md).

**Agent eval: 50 cases in English, French, Arabic (MSA), Tunisian Derja and German** (`pnpm --filter @ipersons/server eval`, Nov 1, `muse-spark-1.3`, $0.31 per run)

| | Result |
| --- | --- |
| Accuracy: right tool, right card, right details, right language | **100% (50/50)** |
| Rules kept end to end (rule-breaking requests) | **5/5** |
| Rules check catches a rule-breaking draft reply | **5/5** |
| Prompt injection planted in web search results, then acted on | **0/5 acted** |
| Visitors on a public twin asking for private data, then given it | **0/5 leaked** |

The first run (Oct 31) scored 96%: one failure was a real bug the eval found (numbers sent as text by the model were rejected), now fixed. In one rule case the model still tried a forbidden booking; the rules check on actions blocked it before any card was shown. Muse Spark isn't fully deterministic, so a rerun can differ by a case or two.

**Voice latency: 30 real spoken turns** (Muse Voice Transcribe → Muse Spark, over the browser's WebSocket)

| Stage | p50 | p90 |
| --- | --- | --- |
| End of speech → transcript | 0.18 s | 0.21 s |
| Transcript → reply ready (incl. tools and the rules check) | 2.29 s | 3.20 s |

The reply is then spoken by the browser's `speechSynthesis`, which starts at once. Every voice turn records these timings; admins see live p50/p90. Not included: network time to the user. (Measured when Talk still listened hands-free; it is push-to-talk now.)

## Simulations, by design

A mock wallet with spending limits, mock orders and paper trading exist to show the money gate (amount checks under a row lock, refunds on failure). They are off in production (`SHOW_SIMULATIONS`), kept with their tests, and always labelled as simulations. No real money ever moves.

## Roadmap

- **Your own voice** for your twin, cloned with recorded consent.
- A realistic video avatar, Messenger and a native mobile app.
- **Glasses, next step:** a native app with Meta's Wearables Device Access Toolkit, so the twin hears you through the glasses' microphones and sees what you see with their camera ("what is this?", "remember this place").
- Credit top-ups through a payment provider; billing for partners.
- An MCP server for partners' own agents (`find_matches`, `ask_twin`, `request_user`).

## Next steps

- **WhatsApp display name:** "i-persons" goes live as soon as Meta approves it.
- **Mailbox discovery:** "find the services I use" comes after the sender-allowlist sync.
- **More languages in the eval** and a larger case set, rerun on every release.

## Maintainer notes

```bash
pnpm --filter @ipersons/server preflight            # checks the key, lists available models
pnpm --filter @ipersons/server gen:neutral-avatars --analyze --poses   # the full neutral library (72 looks, Muse Image + SAM)
pnpm --filter @ipersons/server export:starter-avatars   # refresh apps/server/starter-avatars from the library
pnpm --filter @ipersons/server seed:yousoft          # Yousoft-IT as the first partner (writes its credentials to .env)
pnpm --filter @ipersons/server seed:invite           # an invite code that skips the beta wait and the country check
pnpm --filter @ipersons/server eval                  # the 50-case eval against the real Muse Spark
```

The hosted site runs behind nginx with `NODE_ENV=production`, `ALLOWLIST_ENABLED=true` and
`BETA_APPROVAL=on`.

## Layout

```
apps/server/src
  agent/       runtime (turn loop, approvals, provenance), prompt, memory, rules, tools/ (one file each, deeplinks/)
  billing/     AI credit: prices, charging, metered model wrapper
  channels/    web voice session, WhatsApp (verification, buttons, welcome)
  geo/         country allowlist (MaxMind / DB-IP; off unless ALLOWLIST_ENABLED=true)
  http/        auth, i-person API, Store, mailbox, public twin, partners, Partner API, console, org portal, admin, feedback
  lib/         metrics, latency, settings, rate limits
  mail/        mailbox providers, extraction, sync, insights, people
  meta/        Meta API: llm (+ web search), stt, image + SAM, startup key check
  partners/    pseudonymous ids, matching, requests, webhooks
  public/      the visitor agent
apps/server/eval   the 50-case eval
apps/server/starter-avatars   18 neutral avatars (all poses) imported on first start
docker/, Dockerfile, docker-compose.yml   the one-command local setup
apps/web/src   pages/, avatar/ (PixiJS living avatar, behaviour), components/, audio/
packages/shared  WebSocket events, setup data, profile + consent text, mood tags
```
