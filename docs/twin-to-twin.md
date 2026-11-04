# Contacts, invites and "my twin talks to your twin"

## README text (for the pillar *It speaks for you*)

### My twin talks to your twin

Your contacts page shows which of your contacts already have an i-person. Invite the others, connect with
the ones who do, and let your twins plan a coffee, dinner or meeting: they find times that suit both of
you, propose real places, and put it in both calendars.

**Consent in three sentences:** Twins connect only when both people say yes, and either can disconnect or
block at any time. A twin shares only free/busy times and the preferences its owner ticked, never
calendar details, private facts or contacts. Nothing is booked until both people have said yes.

---

## How it works (for developers)

| Piece | Where |
|---|---|
| Matching contacts to i-persons (keyed hashes of verified identifiers) | `apps/server/src/twins/identifiers.ts`, `matching.ts` |
| What the browser sees for a contact | `twins/view.ts` (other twin's name + avatar proxied via `/api/contacts/:id/twin-avatar`) |
| Invites (email by i-persons, WhatsApp by the user), join links, referral credit | `twins/invites.ts`, page `/join/:token` |
| Connections, scopes, block/report | `twins/connections.ts` |
| Planning protocol | `twins/plans.ts` (+ `slots.ts`, `places.ts`, `suggestions.ts`) |
| Approval cards from these flows | internal tool `twin_request` → `twins/handlers.ts`; notifications `twins/notify.ts` |
| Agent tools | `contacts_status`, `invite_contact`, `connect_twins`, `plan_with_contacts`, `find_places` |
| HTTP | `http/contacts.ts` (contacts, invites, connections, plans), `http/twins-admin.ts` (Admin → Twins) |
| WhatsApp templates | `twins/wa-templates.ts`, `pnpm --filter @ipersons/server wa:templates [--submit]` |
| Demo seed | `pnpm --filter @ipersons/server seed:twins-demo [--yes]` (Hana + Sara) |

### Matching (§1)
- `user_identifiers` holds HMAC-SHA256 (key `IDENTIFIER_HMAC_KEY`, default derived from `APP_ENCRYPTION_KEY`)
  of **verified** identifiers only: the WhatsApp-verified number (E.164), the account email when proven by a
  Google/Microsoft/Facebook sign-in (`users.email_verified_at`), and OAuth-connected mailbox addresses.
  Password sign-up emails are not matchable.
- Contacts are hashed the same way on each sync (hook in `mail/sync.ts`) and nightly (`twins-nightly` job).
  Only `has_iperson` / `matched_user_id` (server-only) / `checked_at` are stored; nobody learns which identifier matched.
- Hidden: discoverability `nobody` (My twin → Privacy), a block by the other person, no twin, suspended.
  Re-checked live on every read, so a change applies at once. An active connection, or a request the other
  person sent, stays visible whatever their discoverability.

### Planning protocol (§5)
1. A asks (card "Ask Sami's i-person for coffee…?" → Approve).
2. B's side computes ≤3 free candidates from B's calendars, rules and working hours — automatically with B's
   `availability` scope (intersected with A's free times only if A granted availability), else after B's
   "Share 3 possible times?" card. Only these instants leave B's side.
3. A's side intersects with A's calendar and finds ≤3 places (partner `venue` offers first, then Muse Spark
   web search kept only for specific pages the search returned). A trims/approves "Send to Sami?".
4. B picks a time and a place (card Approve = first option; other choices, one counter-proposal or Decline
   on the Contacts page). Groups: each picks the times that work; the most-picked time wins; anyone who
   can't make it → "Lea can't make it — go ahead with Sami?".
5. A confirms (or auto-confirm) → built-in calendar for everyone, `.ics` email for read-only Outlook/Google,
   reservation request to partner venues that take them (webhook `reservation.requested`), else hand-off link.
6. Plans expire after 48 h with one reminder at 24 h. Disconnect/block cancels open plans immediately.

The other side's free-text note is shown quoted and labelled ("their words, not checked"), wrapped as
`<untrusted>` for the agent, and never acted on: only the protocol's structured fields drive anything.

### Limits (§7)
Invites 10/day, one per contact per 30 days + one reminder after 7 days, never to suppressed addresses, and
email invites count against the email limits. Connection requests 20/day; 3 declines from different people
in a week pause requests for 24 h (listed in Admin → Twins). Plans: 5 open per user, 2 between the same two people.
