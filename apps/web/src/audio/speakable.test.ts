import { speakable } from '@ipersons/shared';
import { describe, expect, it } from 'vitest';

describe('speakable', () => {
  it('never reads web addresses or markdown aloud', () => {
    expect(speakable('Tunisian police clash with protesters - https://aljazeera.com/x and more on www.bbc.com.'))
      .toBe('Tunisian police clash with protesters and more on.');
    expect(speakable('**Top** news (https://reuters.com/a): rates fall')).toBe('Top news: rates fall');
  });
});
