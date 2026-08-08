import type { VoicePack } from '@kanal/contracts';

/**
 * Canonical English voice pack used by the golden regression suite (plan §15.1).
 * Banned patterns mirror the plan's example: not-x-but-y (hard), tricolon
 * stack (soft), em-dash density (soft), hedge stack (soft).
 */
export const EN_VOICE: VoicePack = {
  apiVersion: 'kanal.dev/v1',
  kind: 'VoicePack',
  coreApi: '^1.2',
  metadata: {
    channel: 'kanal-en',
    locale: 'en',
    version: '1.0.0',
  },
  spec: {
    register: 'informed-peer',
    person: 'none',
    formality: 0.5,
    sentenceLength: { meanTarget: 16, max: 34 },
    structure: {
      opening: 'claim_first',
      maxParagraphs: 4,
      requireTakeaway: true,
      emojiPolicy: 'none',
      hashtagMax: 0,
      linkPosition: 'inline',
    },
    lexicon: {
      prefer: ['bandwidth', 'datasheet', 'benchmark'],
      avoid: ['revolutionary', 'unprecedented'],
      never: ['guaranteed', 'zero risk'],
    },
    bannedPatterns: [
      {
        id: 'not_x_but_y',
        pattern: "(?i)\\b(it'?s not|this isn'?t)\\s+\\w+[^.]{0,40}\\bit'?s\\b",
        kind: 'pattern',
        severity: 'hard',
      },
      {
        id: 'tricolon_stack',
        pattern: '\\b[\\w-]+,\\s+[\\w-]+,\\s+(?:and\\s+)?[\\w-]+(?:[\\s&][\\w-]+)*\\.',
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
      {
        id: 'hedge_stack',
        pattern: '(?i)\\b(may|might|could|potentially|arguably)\\b.{0,60}\\b(may|might|could)\\b',
        kind: 'pattern',
        severity: 'soft',
      },
    ],
    exemplars: [{ postId: 'en-good-1', why: 'number lands in the opening quote, pacing tight' }],
    antiexemplars: [{ text: 'Breakthrough. Game changer.', why: 'generic listicle voice' }],
    learnedCorrections: [],
  },
};
