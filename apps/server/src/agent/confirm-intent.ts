// Detects a spoken/typed "yes" or "no" to a single pending proposal (EN / FR / AR / Tunisian Derja).
// Only short, unambiguous replies count; anything longer goes to the model as a normal turn.

const YES = [
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'go ahead', 'do it', 'please do', 'confirm', 'confirmed',
  'approve', 'approved', 'book it', 'send it', 'yes please', 'ok do it', 'sounds good',
  'oui', 'ouais', "d'accord", 'dac', 'vas-y', 'vas y', 'bien sûr', 'oui vas-y', 'confirme',
  'نعم', 'ايه', 'إيه', 'أيوه', 'ايوه', 'موافق', 'أكيد', 'اكيد', 'باهي', 'na3am', 'ey', 'eyh', 'behi', 'mriguel',
];
const NO = [
  'no', 'nope', 'cancel', "don't", 'do not', 'no thanks', 'not now', 'decline',
  'non', 'annule', 'non merci', 'pas maintenant',
  'لا', 'لا شكرا', 'la', 'le', 'lé',
];

const normalize = (s: string) =>
  s.toLowerCase().normalize('NFC').replace(/[.!?,;:،؟]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\s+(please|thanks|thank you|merci|stp|svp|شكرا)$/, '');

const yes = new Set(YES.map(normalize));
const no = new Set(NO.map(normalize));

export function confirmIntent(text: string): 'yes' | 'no' | null {
  const t = normalize(text);
  if (yes.has(t)) return 'yes';
  if (no.has(t)) return 'no';
  return null;
}
