// WhatsApp utility templates for twin-to-twin (§8). Used only outside the 24-hour window and only once
// Meta approved them (Admin → Twins → "WhatsApp twin templates approved"); until then the flows fall back
// to in-app cards plus email, and to free-form WhatsApp messages inside the window.
// Submit with `pnpm --filter @ipersons/server wa:templates --submit`; check with `wa:check`.
// The parameter order must match the calls in twins/connections.ts and twins/plans.ts.
// Meta's rules: a body may not start or end with a variable, and needs enough words per variable.
// Bodies already submitted keep their text at Meta; the script skips name + language pairs that exist.

export const WA_TEMPLATE_LANGS = ['en', 'fr', 'ar', 'de'] as const;
type Lang = (typeof WA_TEMPLATE_LANGS)[number];

export interface WaTemplateDef {
  name: string;
  /** Meta decides in review; a name keeps the category of its first approval in every language. */
  category: 'UTILITY' | 'MARKETING';
  /** Body per language; {{n}} placeholders. */
  body: Record<Lang, string>;
  /** Example values for Meta's review, one per placeholder. */
  example: string[];
}

export const TWIN_WA_TEMPLATES: WaTemplateDef[] = [
  {
    name: 'twin_connect_request',
    category: 'UTILITY',
    body: {
      en: 'Hello! {{1}} wants to connect their i-person with yours so your twins can plan meetings together. Open i-persons to accept.',
      fr: 'Bonjour ! {{1}} souhaite connecter son i-person au vôtre pour que vos jumeaux puissent organiser des rendez-vous ensemble. Ouvrez i-persons pour accepter.',
      ar: 'يرغب {{1}} في ربط i-person الخاص به بـ i-person الخاص بك حتى يتمكن توأماكما من تنظيم المواعيد معاً. افتح i-persons للموافقة.',
      de: 'Hallo! {{1}} möchte seine i-person mit deiner verbinden, damit eure Zwillinge gemeinsam Treffen planen können. Öffne i-persons, um anzunehmen.',
    },
    example: ['Hana'],
  },
  {
    name: 'twin_plan_request',
    category: 'UTILITY',
    body: {
      en: "Hello! {{1}}'s i-person asks to plan {{2}} with you ({{3}}). Nothing is booked without your yes. Open i-persons to answer.",
      fr: "L'i-person de {{1}} propose d'organiser {{2}} avec vous ({{3}}). Rien n'est réservé sans votre accord. Ouvrez i-persons pour répondre.",
      ar: 'يطلب i-person الخاص بـ {{1}} تنظيم {{2}} معك ({{3}}). لا يتم حجز أي شيء دون موافقتك. افتح i-persons للرد.',
      de: 'Die i-person von {{1}} möchte {{2}} mit dir planen ({{3}}). Ohne dein Ja wird nichts gebucht. Öffne i-persons, um zu antworten.',
    },
    example: ['Hana', 'coffee', 'Tue 4 Nov 10:00, Wed 5 Nov 16:00'],
  },
  {
    name: 'twin_plan_confirmed',
    category: 'UTILITY',
    body: {
      en: 'Good news, your plan is confirmed. {{1}} with {{2}} is set for {{3}} at {{4}}. It is now in your i-persons calendar, where you can see or change it.',
      fr: 'Bonne nouvelle, votre rendez-vous est confirmé. {{1}} avec {{2}} est prévu le {{3}} à {{4}}. Il est maintenant dans votre calendrier i-persons, où vous pouvez le voir ou le modifier.',
      ar: 'تم تأكيد {{1}} مع {{2}}: {{3}} في {{4}}. الموعد في تقويم i-persons الخاص بك.',
      de: 'Gute Nachricht, euer Treffen ist bestätigt. {{1}} mit {{2}} ist am {{3}} bei {{4}} geplant. Es steht jetzt in deinem i-persons-Kalender, wo du es sehen oder ändern kannst.',
    },
    example: ['Coffee', 'Sami', 'Wed 5 Nov 16:00', 'Café Y'],
  },
];

/** The Graph API payload for one template in one language. */
export function templatePayload(t: WaTemplateDef, lang: Lang) {
  return {
    // Meta may reclassify a template in review; letting it do so avoids "category doesn't match" refusals.
    name: t.name, category: t.category, language: lang, allow_category_change: true,
    components: [{ type: 'BODY', text: t.body[lang], example: { body_text: [t.example] } }],
  };
}
