# Third-party services

Every AI model call in i-persons goes to **Meta models** through the Meta Model API. Nothing else in this list
is an AI model call. Speech output uses the browser's built-in `speechSynthesis`.

Only `META_API_KEY` is required. Every other service is optional: without its settings the app starts normally
and the feature shows "not configured" (or falls back as described below).

## AI models (Meta only)

| Service | Used for | Setting | Code |
| --- | --- | --- | --- |
| Meta Model API: Muse Spark | The agent, rules checks, visitor and partner twins, extraction from emails, web search | `META_API_KEY` (**required**) | `apps/server/src/meta/llm.ts` |
| Meta Model API: Muse Voice Transcribe | Live speech-to-text on Talk, WhatsApp voice notes | `META_API_KEY` | `apps/server/src/meta/stt.ts` |
| Meta Model API: Muse Image | Avatars from selfies, the neutral library, poses, styles, scenes | `META_API_KEY` | `apps/server/src/meta/image.ts` |
| Meta Model API: SAM 3.1 | Person cut-out, face, eyes and mouth for the living avatar | `META_API_KEY` | `apps/server/src/meta/image.ts` |

The `openai` npm package is only the client library for Meta's OpenAI-compatible endpoint (`META_BASE_URL`,
default `https://api.meta.ai/v1`). It never calls OpenAI.

## Meta platforms (optional)

| Service | Used for | Settings | Without it |
| --- | --- | --- | --- |
| WhatsApp Cloud API (graph.facebook.com) | Verification, chat, voice notes, approval buttons, alerts | `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_PHONE_NUMBER`, `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `WA_WABA_ID` | WhatsApp shows "not configured"; setup skips the WhatsApp step |
| Facebook Login | "Continue with Facebook" | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_LOGIN_CONFIG_ID` | The button is hidden |
| Meta Ray-Ban Display (Web Apps) | The twin in the glasses' display | A public HTTPS `PUBLIC_URL` | Glasses shows "not configured" (glasses need a public HTTPS address) |

## Sign-in and mailbox (optional)

| Service | Used for | Settings | Without it |
| --- | --- | --- | --- |
| Google OAuth, Gmail API, People API, Calendar API | "Continue with Google"; read-only mailbox, contacts and calendar import | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The button and the Gmail connection are hidden |
| Microsoft identity platform, Microsoft Graph | "Continue with Microsoft"; read-only Outlook mailbox, contacts and calendar import | `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | The button and the Outlook connection are hidden |

## Other services (optional, none of them AI)

| Service | Used for | Settings | Without it |
| --- | --- | --- | --- |
| SMTP server (any provider) | Sending the emails the user approves; invites, approval emails | `SMTP_URL`, `SMTP_FROM` | Emails land in the Activity outbox instead |
| Pexels API | Stock photos for avatar scene backgrounds | `PEXELS_API_KEY` | Scenes use plain backgrounds |
| MaxMind GeoLite2 | Country of an IP address (country allowlist) | `MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY` | Falls back to DB-IP below |
| DB-IP "IP to Country Lite" (download.db-ip.com) | Free country database, used when there is no MaxMind key | none | Country unknown; only matters when `ALLOWLIST_ENABLED=true` |
| Google Fonts | The Inter font on the web app | none | The browser's default sans-serif font |
| User-added remote MCP servers | Tools a user connects in the Service Store | Entered by the user | None connected |

## Links only (no API calls)

Hand-off links open these sites in the user's browser; the server never calls them: Booking.com, Skyscanner,
Amazon. With `SHOW_SIMULATIONS` or demo accounts, neutral demo pages (StayFinder, FlyNow, ShopMate) are used
instead. News sources the user prefers (BBC, Reuters, Al Jazeera…) are only hints for Muse Spark's web search.

## Browser and OS features (not services we call)

| Feature | Used for |
| --- | --- |
| `speechSynthesis` (Web Speech API) | Speaking the twin's replies, with a voice that matches the reply's language. Not an AI model call. In some browsers the voices are provided by the browser maker. |
| `SpeechRecognition` (Web Speech API) | Speech-to-text in demo mode only (no `META_API_KEY`). In Chrome the browser sends the audio to Google; with a key, Muse Voice Transcribe is used instead. |
| `getUserMedia` (microphone, camera) | Talking to the twin and taking a selfie. Browsers allow these only on `localhost` or HTTPS. |
| Web App Manifest | Adding the twin to the phone's home screen |
