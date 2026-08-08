import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * KANAL DDL — mirrors plan §6.2 (ten core tables) plus the secondary tables
 * of §6.3. Postgres 16. uuidv7 ids give monotonicity and index locality.
 * Every table carries org_id and is covered by RLS (plan §16.5).
 */

// ---- uuidv7 (from the pg_uuidv7 extension) ----
export const uuidv7 = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'uuid';
  },
  toDriver(value: string): string {
    return value;
  },
  fromDriver(value: string): string {
    return value;
  },
});

/**
 * Primary-key column: the DB generates the uuid via `DEFAULT gen_random_uuid()`
 * (built into PG16 — no pg_uuidv7 extension needed), so inserts never supply an id.
 */
export const id = () => uuidv7('id').primaryKey().default(sql`gen_random_uuid()`);

export const runStateEnum = pgEnum('run_state', [
  'intake', 'briefed', 'sourcing', 'researched', 'authoring', 'drafting', 'critiquing',
  'revising', 'formatting', 'media_pending', 'policy_check', 'review_pending', 'approved',
  'scheduled', 'publishing', 'published', 'publish_uncertain', 'measuring', 'learned',
  'escalated', 'blocked_policy', 'blocked_budget', 'blocked_provider', 'halted', 'cancelled', 'failed',
]);

export const platformKindEnum = pgEnum('platform_kind', ['telegram', 'bale', 'rubika', 'eitaa', 'x', 'reddit']);
export const sourceKindEnum = pgEnum('source_kind', [
  'rss', 'atom', 'jsonfeed', 'sitemap', 'html_selector', 'reddit_json', 'youtube_rss',
  'hn_algolia', 'arxiv', 'webhook', 'manual',
]);

// -- 1 ----------------------------------------------------------------
export const org = pgTable('org', {
  id: id(),
  name: text('name').notNull(),
  uiLocale: text('ui_locale').notNull().default('en'),
  timezone: text('timezone').notNull().default('UTC'),
  calendarSystem: text('calendar_system').notNull().default('gregory'),
  numeralSystem: text('numeral_system').notNull().default('latn'),
  budgetMonthUsd: numeric('budget_month_usd', { precision: 10, scale: 2 }).notNull().default('50.00'),
  spentMonthUsd: numeric('spent_month_usd', { precision: 10, scale: 4 }).notNull().default('0'),
  budgetPeriodStart: date('budget_period_start').notNull(),
  globalHaltAt: timestamp('global_halt_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// -- 2 ----------------------------------------------------------------
export const channel = pgTable(
  'channel',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    platform: platformKindEnum('platform').notNull(),
    platformChannelId: text('platform_channel_id').notNull(),
    handle: text('handle'),
    displayName: text('display_name').notNull(),
    contentLocale: text('content_locale').notNull().default('en'),
    contentTimezone: text('content_timezone').notNull().default('UTC'),
    defaultLane: text('default_lane').notNull().default('copilot'),
    voicePackId: uuid('voice_pack_id'),
    manifestSetId: uuid('manifest_set_id'),
    credentialRef: text('credential_ref').notNull(),
    capabilities: jsonb('capabilities').notNull().default({}),
    capabilitiesProbedAt: timestamp('capabilities_probed_at', { withTimezone: true }),
    pacingPolicy: jsonb('pacing_policy').notNull().default({}),
    publishHaltedAt: timestamp('publish_halted_at', { withTimezone: true }),
    haltReason: text('halt_reason'),
    budgetDayUsd: numeric('budget_day_usd', { precision: 8, scale: 2 }).notNull().default('2.00'),
    subscriberCount: integer('subscriber_count'),
    subscriberCountAt: timestamp('subscriber_count_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('channel_unique').on(t.orgId, t.platform, t.platformChannelId)],
);

// -- 3 ----------------------------------------------------------------
export const source = pgTable(
  'source',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    kind: sourceKindEnum('kind').notNull(),
    url: text('url'),
    config: jsonb('config').notNull().default({}),
    trustTier: smallint('trust_tier').notNull().default(1),
    trustScore: numeric('trust_score', { precision: 5, scale: 2 }).notNull().default('50.00'),
    pollIntervalS: integer('poll_interval_s').notNull().default(900),
    etag: text('etag'),
    lastModified: text('last_modified'),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    consecutiveFailures: smallint('consecutive_failures').notNull().default(0),
    quarantinedAt: timestamp('quarantined_at', { withTimezone: true }),
    licenseHint: text('license_hint').default('unknown'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('source_unique').on(t.orgId, t.kind, t.url)],
);

// -- 4 ----------------------------------------------------------------
export const sourceItem = pgTable(
  'source_item',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').notNull().references(() => source.id, { onDelete: 'cascade' }),
    canonicalUrl: text('canonical_url').notNull(),
    rawUrl: text('raw_url').notNull(),
    urlHash: uuid('url_hash').notNull(), // sha256(canonical_url) — uuid space in V1 for index locality
    simhash: bigint('simhash', { mode: 'number' }).notNull(),
    clusterId: uuid('cluster_id'),
    title: text('title'),
    bodyText: text('body_text').notNull(),
    bodySha256: uuid('body_sha256').notNull(),
    lang: text('lang'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    httpStatus: smallint('http_status'),
    contentBytes: integer('content_bytes'),
    embedding: jsonb('embedding'), // vector(1024) via pgvector; jsonb alias in V1 for portability
    injectionFlags: text('injection_flags').array().notNull().default([]),
  },
  (t) => [
    uniqueIndex('source_item_url_unique').on(t.orgId, t.urlHash),
    index('source_item_recent_idx').on(t.orgId, t.publishedAt),
    index('source_item_cluster_idx').on(t.clusterId),
  ],
);

// -- 5 ----------------------------------------------------------------
export const run = pgTable(
  'run',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').notNull().references(() => channel.id, { onDelete: 'cascade' }),
    lane: text('lane').notNull(),
    state: runStateEnum('state').notNull().default('intake'),
    cursorStage: text('cursor_stage').notNull().default('intake'),
    brief: jsonb('brief').notNull().default({}),
    manifestSetHash: uuid('manifest_set_hash').notNull(),
    promptPackVersion: text('prompt_pack_version').notNull(),
    policyHash: uuid('policy_hash'),
    traceId: uuid('trace_id').notNull(),
    budgetCapUsd: numeric('budget_cap_usd', { precision: 8, scale: 4 }).notNull().default('0.15'),
    spentUsd: numeric('spent_usd', { precision: 8, scale: 4 }).notNull().default('0'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('run_active_idx')
      .on(t.orgId, t.channelId, t.state)
      .where(sql`state NOT IN ('learned','cancelled','failed')`),
  ],
);

// -- 6 ----------------------------------------------------------------
export const runStep = pgTable(
  'run_step',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull().references(() => run.id, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),
    attempt: smallint('attempt').notNull().default(1),
    agentRef: text('agent_ref'),
    zone: text('zone').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    state: text('state').notNull().default('queued'),
    inputHash: uuid('input_hash').notNull(),
    output: jsonb('output'),
    error: jsonb('error'),
    spanId: uuid('span_id'),
    modelRef: text('model_ref'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedTokens: integer('cached_tokens'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    latencyMs: integer('latency_ms'),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('run_step_unique').on(t.runId, t.stage, t.attempt),
    uniqueIndex('run_step_idem_unique').on(t.idempotencyKey),
    index('run_step_reclaim_idx').on(t.heartbeatAt).where(sql`state = 'in_flight'`),
  ],
);

// -- 7 ----------------------------------------------------------------
export const post = pgTable(
  'post',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').notNull().references(() => channel.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull().references(() => run.id, { onDelete: 'cascade' }),
    currentRevisionId: uuid('current_revision_id'),
    contentLocale: text('content_locale').notNull(),
    riskClass: smallint('risk_class').notNull().default(0),
    isPromotional: boolean('is_promotional').notNull().default(false),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    slotGraceS: integer('slot_grace_s').notNull().default(1200),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('post_run_unique').on(t.runId),
    index('post_due_idx').on(t.channelId, t.scheduledFor).where(sql`published_at IS NULL AND retracted_at IS NULL`),
  ],
);

// -- 8 ----------------------------------------------------------------
export const postRevision = pgTable(
  'post_revision',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    revisionNo: integer('revision_no').notNull(),
    authorActor: text('author_actor').notNull(), // human:<uid> | agent:<id>@<ver>
    bodyMd: text('body_md').notNull(),
    bodyRendered: text('body_rendered').notNull(),
    renderMode: text('render_mode').notNull().default('html'),
    charCount: integer('char_count').notNull(),
    entityCount: integer('entity_count').notNull().default(0),
    media: jsonb('media').notNull().default([]),
    allowedUrls: text('allowed_urls').array().notNull().default([]),
    claimIds: uuid('claim_ids').array().notNull().default([]),
    evalScores: jsonb('eval_scores'),
    bannedPatterns: jsonb('banned_patterns').notNull().default([]),
    contentSha256: uuid('content_sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('post_revision_unique').on(t.postId, t.revisionNo)],
);

// -- 9 ----------------------------------------------------------------
export const approval = pgTable(
  'approval',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull().references(() => run.id, { onDelete: 'cascade' }),
    gate: text('gate').notNull(),
    payloadHash: uuid('payload_hash').notNull(),
    state: text('state').notNull().default('pending'),
    escalationChain: uuid('escalation_chain').array().notNull().default([]),
    escalatedToIndex: smallint('escalated_to_index').notNull().default(0),
    slaDeadline: timestamp('sla_deadline', { withTimezone: true }).notNull(),
    hardExpiry: timestamp('hard_expiry', { withTimezone: true }).notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    reasonCode: text('reason_code'),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('approval_one_open_per_gate').on(t.runId, t.gate).where(sql`state = 'pending'`),
    index('approval_sla_idx').on(t.slaDeadline).where(sql`state = 'pending'`),
  ],
);

// -- 9b --------------------------------------------------------------
/**
 * publish_intent (plan §4.1, §7.2, §9.2 #14). The ONLY row that authorizes a
 * publish. Created exclusively by a human HTTP action or the signed
 * autopublish policy evaluator — never by an agent (§7.2 D2, §16.2 A1). The
 * `ops.publish` stage reads a `consumed=false` intent for the run and turns it
 * into a `publish_attempt`. Agents have no write path to this table.
 */
export const publishIntent = pgTable(
  'publish_intent',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull().references(() => run.id, { onDelete: 'cascade' }),
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    revisionId: uuid('revision_id').notNull().references(() => postRevision.id),
    channelId: uuid('channel_id').notNull().references(() => channel.id),
    createdBy: text('created_by').notNull(), // human:<uid> | policy:<policyId>
    policyHash: uuid('policy_hash'),
    payloadHash: uuid('payload_hash').notNull(),
    consumed: boolean('consumed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    index('publish_intent_open_idx')
      .on(t.runId)
      .where(sql`consumed = false`),
  ],
);

// -- 10 --------------------------------------------------------------
export const publishAttempt = pgTable(
  'publish_attempt',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    revisionId: uuid('revision_id').notNull().references(() => postRevision.id),
    channelId: uuid('channel_id').notNull().references(() => channel.id),
    platform: platformKindEnum('platform').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    state: text('state').notNull().default('in_flight'),
    platformMessageId: text('platform_message_id'),
    requestStartedAt: timestamp('request_started_at', { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    httpStatus: smallint('http_status'),
    platformErrorCode: text('platform_error_code'),
    platformErrorDesc: text('platform_error_desc'),
    retryAfterS: integer('retry_after_s'),
    attemptNo: smallint('attempt_no').notNull().default(1),
    deletableUntil: timestamp('deletable_until', { withTimezone: true }),
    editable: boolean('editable').notNull().default(true),
  },
  (t) => [
    uniqueIndex('publish_attempt_idem_unique').on(t.idempotencyKey),
    index('publish_attempt_uncertain_idx').on(t.channelId).where(sql`state = 'uncertain'`),
  ],
);

// ---- Secondary tables (plan §6.3) ----

export const claim = pgTable('claim', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  sourceItemId: uuid('source_item_id').notNull().references(() => sourceItem.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  charStart: integer('char_start').notNull(),
  charEnd: integer('char_end').notNull(),
  confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('0.5'),
  isQuote: boolean('is_quote').notNull().default(false),
});

export const provider = pgTable('provider', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  dialect: text('dialect').notNull(), // openai_compatible | anthropic | ollama
  baseUrl: text('base_url').notNull(),
  authKind: text('auth_kind').notNull().default('bearer'),
  customHeaderName: text('custom_header_name'),
  keyCiphertext: text('key_ciphertext'),
  extraHeaders: jsonb('extra_headers').notNull().default({}),
  proxyUrl: text('proxy_url'),
  dnsMode: text('dns_mode').notNull().default('system'),
  dohUrl: text('doh_url'),
  tlsInsecure: boolean('tls_insecure').notNull().default(false),
  timeoutMs: integer('timeout_ms').notNull().default(60000),
  maxConcurrent: integer('max_concurrent').notNull().default(4),
  healthState: text('health_state').notNull().default('unconfigured'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastError: jsonb('last_error'),
});

export const model = pgTable('model', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  providerId: uuid('provider_id').notNull().references(() => provider.id, { onDelete: 'cascade' }),
  modelRef: text('model_ref').notNull(),
  capabilities: jsonb('capabilities').notNull().default({}),
  capabilitiesDrifted: boolean('capabilities_drifted').notNull().default(false),
  contextWindow: integer('context_window'),
  overrideByHuman: boolean('override_by_human').notNull().default(false),
});

export const modelPrice = pgTable('model_price', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  modelRef: text('model_ref').notNull(),
  inputUsdPerMtok: numeric('input_usd_per_mtok', { precision: 10, scale: 4 }).notNull(),
  outputUsdPerMtok: numeric('output_usd_per_mtok', { precision: 10, scale: 4 }).notNull(),
  cachedInputUsdPerMtok: numeric('cached_input_usd_per_mtok', { precision: 10, scale: 4 }),
  source: text('source').notNull().default('seed'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const costLedger = pgTable('cost_ledger', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').notNull().references(() => run.id, { onDelete: 'cascade' }),
  stepId: uuid('step_id').references(() => runStep.id),
  modelRef: text('model_ref').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  cachedTokens: integer('cached_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull(),
  pricingConfidence: text('pricing_confidence').notNull().default('high'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agentManifest = pgTable('agent_manifest', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  manifestId: text('manifest_id').notNull(),
  semver: text('semver').notNull(),
  yamlSource: text('yaml_source').notNull(),
  parsed: jsonb('parsed').notNull(),
  coreApiRange: text('core_api_range').notNull(),
  contentSha256: uuid('content_sha256').notNull(),
});

export const promptPack = pgTable('prompt_pack', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  packId: text('pack_id').notNull(),
  semver: text('semver').notNull(),
  coreApiRange: text('core_api_range').notNull(),
  locale: text('locale').notNull().default('en'),
  templates: jsonb('templates').notNull(),
  signature: text('signature'),
});

export const voicePack = pgTable('voice_pack', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').references(() => channel.id, { onDelete: 'cascade' }),
  semver: text('semver').notNull(),
  content: jsonb('content').notNull(),
  contentSha256: uuid('content_sha256').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const policy = pgTable('policy', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // autopublish | pacing | promo_density
  name: text('name').notNull(),
  version: text('version').notNull(),
  content: jsonb('content').notNull(),
  contentSha256: uuid('content_sha256').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sourceBinding = pgTable(
  'source_binding',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').notNull().references(() => channel.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').notNull().references(() => source.id, { onDelete: 'cascade' }),
    weight: numeric('weight', { precision: 4, scale: 3 }).notNull().default('1.0'),
    enabled: boolean('enabled').notNull().default(true),
    topicFilter: text('topic_filter'),
  },
  (t) => [uniqueIndex('source_binding_unique').on(t.channelId, t.sourceId)],
);

export const metricSnapshot = pgTable('metric_snapshot', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  publishAttemptId: uuid('publish_attempt_id').notNull().references(() => publishAttempt.id, { onDelete: 'cascade' }),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  source: text('source').notNull(), // bot_api | mtproto
  metric: text('metric').notNull(), // views | forwards | reactions | subscribers ...
  value: numeric('value', { precision: 12, scale: 2 }).notNull(),
});

export const auditEvent = pgTable('audit_event', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  prevHash: uuid('prev_hash'),
  actor: text('actor').notNull(), // human:<uid> | agent:<id>@<ver> | policy:<id>@<sha>
  verb: text('verb').notNull(),
  objectRef: text('object_ref').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  traceId: uuid('trace_id'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export const experiment = pgTable('experiment', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => channel.id, { onDelete: 'cascade' }),
  hypothesis: text('hypothesis').notNull(),
  armDefinition: jsonb('arm_definition').notNull(),
  assignmentRule: text('assignment_rule').notNull(),
  plannedN: integer('planned_n').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
  result: jsonb('result'),
});

export const mtprotoSession = pgTable('mtproto_session', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => channel.id, { onDelete: 'cascade' }),
  sessionBlobCiphertext: text('session_blob_ciphertext').notNull(),
  consentRecordedAt: timestamp('consent_recorded_at', { withTimezone: true }),
  consentTextHash: uuid('consent_text_hash'),
  lastFloodWaitAt: timestamp('last_flood_wait_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

/**
 * The job queue (plan §12.3). One table, partitioned by `queue`:
 * pipeline | ingest | publish | metrics. Dequeue is `FOR UPDATE SKIP LOCKED`.
 * The singleton partial unique index prevents duplicate in-flight jobs for the
 * same key (a pipeline run, a channel publish, a due source poll).
 *
 * This is deliberately NOT org-tenant-isolated by RLS: the queue is the
 * coordinator's private scratch space, and every payload carries org_id for the
 * handler to set the RLS context before touching tenant tables.
 */
export const job = pgTable(
  'job',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    queue: text('queue').notNull(),
    singletonKey: text('singleton_key'),
    payload: jsonb('payload').notNull().default({}),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(5),
    state: text('state').notNull().default('ready'),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('job_singleton_in_flight_unique')
      .on(t.queue, t.singletonKey)
      .where(sql`state IN ('ready','running') AND singleton_key IS NOT NULL`),
    index('job_ready_idx').on(t.queue, t.runAt).where(sql`state = 'ready'`),
  ],
);

// ---- RLS ----
export const runState = run.state; // alias for convenience
export const platform = channel.platform; // alias
