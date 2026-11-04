# i-persons for partners: quick start

## What partners can do
- **Publish offers** (jobs, deals, events, services) for the countries you choose.
- **See who fits**: matched people appear as anonymous twin ids (`tw_…`) with a score and a one-line reason. Matching uses only what people made public, never gender or age.
- **Talk to a twin**: ask a matched person's i-person questions about the offer. It answers only from their public facts and can't accept or promise anything.
- **Send requests**: a meeting, contact details, a CV, or something else. Each request becomes an Approve / Decline card for the person. You learn who they are only if they say yes.

## The consent model
1. People activate you in the i-persons Service Store and choose what you may do (receive offers, talk to their twin, ask them for things). They can pause or block you at any time.
2. You see a **different pseudonymous id per partner** for the same person, so ids can't be linked across partners.
3. Everything you send is treated as untrusted text: it can't make a twin do anything.
4. Shared data (contact details, CV) reaches you **once**, after the person approves, through the API or a signed webhook.

Note: Yousoft-IT operates i-persons and is also its first partner (recruiting). It uses only this public API, with the same rules and limits as everyone; its Store card says "Operated by the i-persons team".

## Onboarding in five steps
1. **Apply** at https://i-persons.com/developers (company, website, what you'll use it for, scopes).
2. **Approval**: an admin reviews and approves you with scopes (`offers:write`, `matches:read`, `twins:converse`, `requests:write`, `webhooks:manage`).
3. **Store entry**: your card (name, tagline, what you'll ask for) goes live in the Service Store.
4. **Choose how you work**:
   - **No code**: sign in and open `/console/<your-slug>` to post offers with a form, see matches, ask twins and send requests.
   - **API**: ask the admin for client credentials (`client_id`, `client_secret`, shown once).
5. **Go live**: publish your first offer; matches appear as people who activated you fit it.

## curl examples
```bash
# 1. A token (valid 15 minutes)
curl -s -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials https://i-persons.com/api/partner/v1/oauth/token

# 2. Publish an offer
curl -s https://i-persons.com/api/partner/v1/offers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"event","title":"Coffee tasting evening","description":"Three single-origin coffees with the roaster, Friday 19:00.","countries":["TN"],"location":"Sfax"}'

# 3. Who fits?
curl -s https://i-persons.com/api/partner/v1/offers/$OFFER_ID/matches -H "Authorization: Bearer $TOKEN"

# 4. Ask a twin, then send a request (the person approves)
curl -s -X POST https://i-persons.com/api/partner/v1/twins/$TWIN_ID/conversations -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"offer_id\":\"$OFFER_ID\"}"
curl -s -X POST https://i-persons.com/api/partner/v1/twins/$TWIN_ID/requests -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"kind\":\"schedule\",\"offer_id\":\"$OFFER_ID\",\"slots\":[\"2026-11-07T18:00:00Z\"]}"

# 5. Your requests and their status
curl -s https://i-persons.com/api/partner/v1/requests -H "Authorization: Bearer $TOKEN"
```

## Verifying webhooks (TypeScript)
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

// X-IPersons-Signature: "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}`>"
export function verify(secret: string, rawBody: string, header: string): boolean {
  const t = /t=(\d+)/.exec(header)?.[1];
  const v1 = /v1=([0-9a-f]+)/.exec(header)?.[1];
  if (!t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const want = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return want.length === v1.length && timingSafeEqual(Buffer.from(want), Buffer.from(v1));
}
```

Full reference: https://i-persons.com/developers-api.html
