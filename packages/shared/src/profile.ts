// Onboarding profile and consent, shared so the web shows exactly the text the server records.

export const GENDERS = [
  { id: 'woman', label: 'Woman' },
  { id: 'man', label: 'Man' },
  { id: 'unspecified', label: 'Prefer not to say' },
] as const;
export type Gender = (typeof GENDERS)[number]['id'];

/** Adults only: there is deliberately no under-18 option. */
export const AGE_RANGES = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+'] as const;
export type AgeRange = (typeof AGE_RANGES)[number];

/** Bump the version whenever the text changes: existing users are asked to accept again. */
export const CONSENT_VERSION = 1;
export const CONSENT_TEXT =
  'I am 18 or older. I agree that i-persons creates a digital twin that represents me, that my photo and voice input are processed by Meta’s AI models to run the service, and that my twin never acts in my name without my approval.';
