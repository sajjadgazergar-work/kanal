import type { VoicePack } from '@kanal/contracts';

/**
 * Canonical Persian voice pack used by the golden regression suite (plan §15.1).
 * Mirrors the plan's Persian example: `never` terms are hard fails, banned
 * patterns include the comma-tricolon (soft) and em-dash density (soft).
 */
export const FA_VOICE: VoicePack = {
  apiVersion: 'kanal.dev/v1',
  kind: 'VoicePack',
  coreApi: '^1.2',
  metadata: {
    channel: 'kanal-fa',
    locale: 'fa',
    version: '1.0.0',
  },
  spec: {
    register: 'analyst',
    person: 'none',
    formality: 0.6,
    sentenceLength: { meanTarget: 18, max: 40 },
    structure: {
      opening: 'claim_first',
      maxParagraphs: 4,
      requireTakeaway: true,
      emojiPolicy: 'none',
      hashtagMax: 0,
      linkPosition: 'end',
    },
    lexicon: {
      prefer: ['پهنای باند', 'برگه مشخصات'],
      avoid: ['بی‌نظیر', 'در دنیای امروز'],
      never: ['تضمینی', 'سود قطعی'],
    },
    bannedPatterns: [
      {
        id: 'fa_comma_stack',
        pattern: '(?:[^،.!؟\\n]+،){2,}[^،.!؟\\n]+[.!؟]',
        kind: 'pattern',
        severity: 'soft',
      },
      {
        id: 'em_dash_density',
        pattern: '—',
        kind: 'density',
        token: '—',
        maxPer100Words: 1.5,
        severity: 'soft',
      },
    ],
    exemplars: [{ postId: 'fa-good-1', why: 'numbers land early, attributed quote, tight pacing' }],
    antiexemplars: [{ text: 'انقلابی. بی‌نظیر.', why: 'generic listicle voice' }],
    learnedCorrections: [],
  },
};
