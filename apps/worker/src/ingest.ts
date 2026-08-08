import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { pollFeed, processItems, dedupAssignCluster, type DedupCandidate } from '@kanal/sources';
import type { SourceItemInput } from '@kanal/sources';
import { setOrgContext } from './db.js';

/**
 * The ingest role (plan §12.7). A `source` is due when its poll_interval has
 * elapsed. The worker:
 *
 *   1. claims due sources (singleton-locked, SKIP LOCKED) and fetches each,
 *   2. runs items through the source pipeline (canonicalize → normalize →
 *      simhash → freshness),
 *   3. dedups against existing `source_item` rows (simhash + url hash),
 *   4. inserts new items, updating source etag/last_modified/poll timestamps.
 *
 * Ingest is a separate concurrency class from the pipeline so HTML extraction
 * cannot starve model calls (plan §12.7).
 */

export interface IngestJobPayload {
  sourceId: string;
}

interface SourceRow {
  id: string;
  org_id: string;
  kind: string;
  url: string | null;
  config: Record<string, unknown>;
  etag: string | null;
  last_modified: string | null;
  poll_interval_s: number;
}

/** A connector dispatch: RSS/Atom/JSONFeed via pollFeed, others 501. */
export function fetchForSource(source: SourceRow): Promise<{ items: SourceItemInput[]; etag: string | null; lastModified: string | null }> {
  if (source.kind === 'rss' || source.kind === 'atom' || source.kind === 'jsonfeed') {
    if (!source.url) return Promise.resolve({ items: [], etag: null, lastModified: null });
    return pollFeed(source.url, {
      etag: source.etag,
      lastModified: source.last_modified,
      spaPathPrefixes: Array.isArray(source.config?.['spa_path_prefixes']) ? (source.config['spa_path_prefixes'] as string[]) : undefined,
    }).then((res) => ({
      items: res.items,
      etag: res.etag ?? null,
      lastModified: res.lastModified ?? null,
    }));
  }
  // sitemap / html_selector / webhook are handled by dedicated pollers in
  // later milestones; V1 ingests the feed family plus manual (no-op).
  if (source.kind === 'manual') return Promise.resolve({ items: [], etag: null, lastModified: null });
  console.warn(`[ingest] source ${source.id} kind '${source.kind}' not supported yet`);
  return Promise.resolve({ items: [], etag: null, lastModified: null });
}

export function createIngestHandler(
  db: NodePgDatabase,
  opts: { vectorsOn?: boolean } = {},
): (job: IngestJobPayload) => Promise<{ inserted: number; skipped: number }> {
  const vectorsOn = opts.vectorsOn ?? process.env.KANAL_VECTOR !== 'off';

  return async function handle(job: IngestJobPayload): Promise<{ inserted: number; skipped: number }> {
    const source = await loadSource(db, job.sourceId);
    if (!source) return { inserted: 0, skipped: 0 };

    await setOrgContext(db, source.org_id);

    const { items, etag, lastModified } = await fetchForSource(source);
    const processed = processItems(items, { vectorsOn });

    let inserted = 0;
    let skipped = 0;
    for (const item of processed) {
      const urlHash = item.urlHash;
      const existing = await db.execute(sql`
        SELECT id FROM source_item WHERE org_id = ${source.org_id} AND url_hash = ${urlHash}::uuid;
      `);
      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

      // Dedup against near-duplicates by simhash within the dedup window.
      const index = await loadDedupIndex(db, source.org_id);
      const candidate = {
        id: urlHash,
        simhash: item.simhash,
        title: item.title ?? null,
        bodyText: item.bodyText,
        firstSeenAt: item.firstSeenAt,
        clusterId: null,
      };
      const dup = dedupAssignCluster(candidate, index, item.fetchedAt, vectorsOn);

      await db.execute(sql`
        INSERT INTO source_item (org_id, source_id, canonical_url, raw_url, url_hash, simhash, cluster_id,
                                 title, body_text, body_sha256, lang, published_at, first_seen_at, fetched_at,
                                 http_status, content_bytes, injection_flags)
        VALUES (${source.org_id}, ${source.id}, ${item.canonicalUrl}, ${item.rawUrl},
                ${urlHash}::uuid, ${item.simhash}::bigint, ${dup.clusterId ?? null},
                ${item.title}, ${item.bodyText}, ${item.bodySha256}::uuid, ${item.lang},
                ${item.publishedAt}, ${item.firstSeenAt}, ${item.fetchedAt},
                ${null}, ${null}, '{}')
        ON CONFLICT (org_id, url_hash) DO NOTHING;
      `);
      inserted++;
    }

    // Update source poll timestamps + conditional-GET headers.
    await db.execute(sql`
      UPDATE source SET last_polled_at = now(), etag = ${etag}, last_modified = ${lastModified},
        consecutive_failures = 0, last_ok_at = now()
      WHERE id = ${source.id};
    `);

    return { inserted, skipped };
  };
}

async function loadSource(db: NodePgDatabase, sourceId: string): Promise<SourceRow | null> {
  const rows = await db.execute(sql`
    SELECT id, org_id, kind, url, config, etag, last_modified, poll_interval_s
    FROM source WHERE id = ${sourceId};
  `);
  return (rows.rows[0] as unknown as SourceRow | undefined) ?? null;
}

/** Build a dedup index of recent source_items for one org (plan §8.4). */
async function loadDedupIndex(db: NodePgDatabase, orgId: string): Promise<DedupCandidate[]> {
  const rows = await db.execute(sql`
    SELECT id, simhash, title, first_seen_at, cluster_id FROM source_item
    WHERE org_id = ${orgId}
    ORDER BY first_seen_at DESC LIMIT 500;
  `);
  return (rows.rows as unknown as Array<{
    id: string; simhash: string; title: string | null; first_seen_at: Date; cluster_id: string | null;
  }>).map((r) => ({
    id: r.id,
    simhash: r.simhash,
    title: r.title,
    firstSeenAt: new Date(r.first_seen_at),
    clusterId: r.cluster_id,
  }));
}
