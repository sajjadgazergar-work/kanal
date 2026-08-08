import { z } from 'zod';

/**
 * The brand-voice pack format (plan §15.1). YAML, versioned per channel,
 * human-editable, diffable. This is the artefact the anti-slop system revolves
 * around.
 */

const bannedPatternSchema = z.object({
  id: z.string(),
  pattern: z.string(), // regex, evaluated deterministically
  kind: z.enum(['pattern', 'density']).default('pattern'),
  token: z.string().optional(),
  maxPer100Words: z.number().positive().optional(),
  severity: z.enum(['hard', 'soft']),
});

export const voicePackSchema = z.object({
  apiVersion: z.literal('kanal.dev/v1'),
  kind: z.literal('VoicePack'),
  coreApi: z.string(),
  metadata: z.object({
    channel: z.string(),
    locale: z.string(),
    version: z.string(),
  }),
  spec: z.object({
    register: z.enum(['informed-peer', 'analyst', 'reporter', 'enthusiast', 'contrarian']),
    person: z.enum(['first_singular', 'first_plural', 'none']),
    formality: z.number().min(0).max(1),
    sentenceLength: z.object({
      meanTarget: z.number().positive(),
      max: z.number().positive(),
    }),
    structure: z.object({
      opening: z.enum(['claim_first', 'question', 'anecdote', 'number']),
      maxParagraphs: z.number().int().positive(),
      requireTakeaway: z.boolean(),
      emojiPolicy: z.enum(['none', 'sparse', 'free']),
      hashtagMax: z.number().int().nonnegative(),
      linkPosition: z.enum(['end', 'inline']),
    }),
    lexicon: z.object({
      prefer: z.array(z.string()),
      avoid: z.array(z.string()),
      never: z.array(z.string()),
    }),
    bannedPatterns: z.array(bannedPatternSchema),
    exemplars: z.array(z.object({ postId: z.string(), why: z.string() })),
    antiexemplars: z.array(z.object({ text: z.string(), why: z.string() })),
    learnedCorrections: z.array(
      z.object({
        id: z.string(),
        rule: z.string(),
        evidence: z.array(z.string()),
        addedAt: z.string(),
        weight: z.number().min(0).max(1),
        decayAfterDays: z.number().int().positive(),
      }),
    ),
  }),
});
export type VoicePack = z.infer<typeof voicePackSchema>;
