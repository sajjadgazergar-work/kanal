import { drizzle } from 'drizzle-orm/node-postgres';
import { modelPrice } from './schema.js';

/**
 * Seed data. Prices live in the `model_price` table, never in code (plan A8).
 * These are tier-band assumptions used for estimation (§9.3), not vendor quotes;
 * the UI shows `confirmed_at` so an operator knows what they are.
 */
export const DEFAULT_PRICES = [
  // tier S
  { modelRef: 'tier:S', inputUsdPerMtok: '0.15', outputUsdPerMtok: '0.60', source: 'band-assumption' },
  // tier M
  { modelRef: 'tier:M', inputUsdPerMtok: '1.00', outputUsdPerMtok: '4.00', source: 'band-assumption' },
  // tier L
  { modelRef: 'tier:L', inputUsdPerMtok: '3.00', outputUsdPerMtok: '15.00', source: 'band-assumption' },
  // tier V
  { modelRef: 'tier:V', inputUsdPerMtok: '1.00', outputUsdPerMtok: '4.00', source: 'band-assumption' },
  // local
  { modelRef: 'tier:local', inputUsdPerMtok: '0.00', outputUsdPerMtok: '0.00', source: 'band-assumption' },
];

/**
 * Seeds the tier-band price assumptions for an org. Prices are overridable in
 * the `model_price` table by the operator.
 */
export async function seedPrices(db: ReturnType<typeof drizzle>, orgId: string) {
  for (const p of DEFAULT_PRICES) {
    await db
      .insert(modelPrice)
      .values({
        orgId,
        modelRef: p.modelRef,
        inputUsdPerMtok: p.inputUsdPerMtok,
        outputUsdPerMtok: p.outputUsdPerMtok,
        source: p.source,
      })
      .onConflictDoNothing();
  }
}
