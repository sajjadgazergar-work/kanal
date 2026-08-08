export { EN_VOICE } from './en.js';
export { FA_VOICE } from './fa.js';

import type { VoicePack } from '@kanal/contracts';
import { EN_VOICE } from './en.js';
import { FA_VOICE } from './fa.js';

/** Voice pack for a given locale; falls back to the canonical set. */
export function voiceForLocale(locale: string): VoicePack {
  switch (locale) {
    case 'en':
      return EN_VOICE;
    case 'fa':
      return FA_VOICE;
    default:
      return EN_VOICE;
  }
}
