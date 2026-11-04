// "my mom", "Mum", "grandma": family words people say, mapped to the label a contact carries ("mother", "grandmother").

const KIN: Record<string, string> = {
  mom: 'mother', mum: 'mother', mommy: 'mother', mummy: 'mother', mama: 'mother', ma: 'mother', mother: 'mother', maman: 'mother', mutter: 'mother',
  dad: 'father', daddy: 'father', papa: 'father', pa: 'father', father: 'father', vater: 'father',
  grandma: 'grandmother', granny: 'grandmother', nana: 'grandmother', grandmother: 'grandmother', oma: 'grandmother', mamie: 'grandmother',
  grandpa: 'grandfather', granddad: 'grandfather', grandfather: 'grandfather', opa: 'grandfather', papi: 'grandfather',
  wife: 'wife', husband: 'husband', son: 'son', daughter: 'daughter', sister: 'sister', brother: 'brother', sis: 'sister', bro: 'brother',
};

/** The family label a phrase means ("my mom" → "mother"), or undefined when it isn't a family word. */
export function kinLabel(phrase: string): string | undefined {
  const w = phrase.trim().toLowerCase().replace(/^(my|our|ma|mon|mein|meine)\s+/, '').replace(/[’'`]s$/, '').trim();
  return KIN[w];
}
