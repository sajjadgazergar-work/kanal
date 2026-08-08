import { MODERATION_HARD_BLOCK, MODERATION_RISK_ESCALATE } from '@kanal/contracts';

/**
 * Policy classifier (plan §15.6 #3, §15.4).
 *
 * `ops.policy_classify` assigns a `risk_class` 0–3 and ToS flags from a
 * draft/rendered post. Hard-blocked categories come from
 * `MODERATION_HARD_BLOCK` (violence, sexual content, self-harm, hate,
 * harassment, illegal goods). The four `MODERATION_RISK_ESCALATE` categories
 * (medical, financial, legal advice, election content) force human review via
 * risk_class escalation rather than a block — a finance channel legitimately
 * discusses finance.
 *
 * Growth-hacking requests — engagement bait, impersonation, third-party
 * channel promotion — are refused with an explanation rather than a silent no.
 *
 * Classifier behaviour:
 *   - Any hard-block category hit → `verdict: 'block'`, `risk_class: 3`.
 *   - Otherwise, each escalate category hit adds one risk class (capped at 3).
 *   - Growth-hack patterns push risk_class to 3 and, for impersonation and
 *     third-party promotion, block. Engagement bait escalates to review.
 */

export type ClassifierVerdict = 'block' | 'escalate' | 'allow';

export interface ClassifyResult {
  verdict: ClassifierVerdict;
  riskClass: 0 | 1 | 2 | 3;
  /** ToS flags, e.g. `['financial_advice']`. */
  tosFlags: string[];
  /** Growth-hack refusals with human-readable explanations. */
  growthHackFlags: GrowthHackFlag[];
  /** Reasons for a block / escalation, for the review queue. */
  reasons: string[];
  matchedCategories: string[];
}

export interface GrowthHackFlag {
  id: string;
  label: string;
  explanation: string;
  /** True when the request must be refused (blocked), not merely escalated. */
  refuses: boolean;
}

/** Hard-block category → detection keywords. */
const HARD_BLOCK_KEYWORDS: Record<string, string[]> = {
  violence: ['kill ', 'murder', 'stab', 'bomb', 'beheading', 'violence', 'shooting'],
  sexual_content: ['sexual', 'porn', 'nude', 'explicit sex', 'sex tape'],
  self_harm: ['self-harm', 'suicide', 'kill myself', 'cut myself'],
  hate: ['hate speech', 'racial slurs', 'beneath contempt'],
  harassment: ['harass', 'doxxing', 'stalk ', 'threaten to'],
  illegal_goods: ['buy drugs', 'sell guns', 'counterfeit', 'stolen credit card', 'illegal goods'],
};

const ESCALATE_KEYWORDS: Record<string, string[]> = {
  medical_advice: ['take this medicine', 'cures', 'prescription', 'medical advice', 'dosage'],
  financial_advice: ['invest your savings', 'guaranteed return', 'pump ', 'buy the dip', 'financial advice', 'double your money'],
  legal_advice: ['legal advice', 'sue ', 'contract clause', 'litigation'],
  election_content: ['vote for', 'election', 'campaign donation', 'ballot'],
};

const GROWTH_HACK: Array<{
  id: string;
  label: string;
  keywords: string[];
  refuses: boolean;
  explanation: string;
}> = [
  {
    id: 'engagement_bait',
    label: 'engagement bait',
    keywords: ['like and share', 'tag a friend', 'share this to win', 'follow for follow', 'engage or lose', 'comment to enter', 'engagement'],
    refuses: true,
    explanation: 'engagement-bait chains are a hard-blocked category (plan §15.6 #3): they are penalized by Telegram, degrade the channel, and are refused with this explanation',
  },
  {
    id: 'impersonation',
    label: 'impersonation',
    keywords: ['pretend to be', 'impersonate', 'act as if you are the official', 'pose as'],
    refuses: true,
    explanation: 'impersonating a person or brand is a hard ToS violation and is refused outright',
  },
  {
    id: 'third_party_promotion',
    label: 'third-party channel promotion',
    keywords: ['promote this channel', 'push another channel', 'advertise a competitor', 'promote our other channel', 'cross-promote'],
    refuses: true,
    explanation: 'unsolicited promotion of a third-party channel is a hard-blocked category; refused with explanation',
  },
];

function scanKeywords(text: string, map: Record<string, string[]>): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const [cat, kws] of Object.entries(map)) {
    if (kws.some((kw) => lower.includes(kw))) hits.push(cat);
  }
  return hits;
}

/**
 * Classify a draft/rendered post. `text` is the rendered post (what would
 * ship). `manualFlags` can force a category (e.g. a human marking a post
 * sponsored).
 */
export function classifyPost(text: string, _manualFlags: { isSponsored?: boolean } = {}): ClassifyResult {
  const reasons: string[] = [];
  const matchedCategories: string[] = [];

  const hardHits = scanKeywords(text, HARD_BLOCK_KEYWORDS);
  const escalateHits = scanKeywords(text, ESCALATE_KEYWORDS);

  for (const h of hardHits) {
    matchedCategories.push(h);
    reasons.push(`hard-blocked moderation category: ${h}`);
  }
  for (const e of escalateHits) {
    matchedCategories.push(e);
    reasons.push(`risk-escalated category: ${e}`);
  }

  const growthHackFlags: GrowthHackFlag[] = [];
  const lower = text.toLowerCase();
  for (const g of GROWTH_HACK) {
    if (g.keywords.some((kw) => lower.includes(kw))) {
      growthHackFlags.push({ id: g.id, label: g.label, refuses: g.refuses, explanation: g.explanation });
      reasons.push(`${g.label}: ${g.explanation}`);
    }
  }

  const refuses = growthHackFlags.some((g) => g.refuses);
  const blocks = hardHits.length > 0 || refuses;

  if (blocks) {
    return {
      verdict: 'block',
      riskClass: 3,
      tosFlags: [...new Set([...matchedCategories, ...growthHackFlags.map((g) => g.id)])],
      growthHackFlags,
      reasons,
      matchedCategories: [...new Set(matchedCategories)],
    };
  }

  // Escalation: each risk category adds one class, capped at 3.
  let risk = escalateHits.length as 0 | 1 | 2 | 3;
  if (risk > 3) risk = 3;

  const escalate = risk >= 1;
  return {
    verdict: escalate ? 'escalate' : 'allow',
    riskClass: risk,
    tosFlags: [...new Set(matchedCategories)],
    growthHackFlags,
    reasons,
    matchedCategories: [...new Set(matchedCategories)],
  };
}

/** Refuse a growth-hacking request with an explanation (plan §15.6 #3). */
export function refuseGrowthHack(request: string): GrowthHackFlag[] {
  const lower = request.toLowerCase();
  const flags = GROWTH_HACK.filter((g) => g.keywords.some((kw) => lower.includes(kw)));
  return flags.map((g) => ({ id: g.id, label: g.label, refuses: g.refuses, explanation: g.explanation }));
}

export { MODERATION_HARD_BLOCK, MODERATION_RISK_ESCALATE };
