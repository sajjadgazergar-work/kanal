/**
 * English catalogue (plan §14.8). ICU MessageFormat.
 * Pluralization uses CLDR categories (one/other).
 */
import type { MessageArgs } from '../message-format.js';
import { formatMessage } from '../message-format.js';

/** Catalogue keys — keep in sync with fa.ts (a lint check enforces parity). */
export const enKeys = [
  // nav
  'nav.today',
  'nav.queue',
  'nav.channels',
  'nav.ops',
  'nav.cost',
  'nav.settings',
  'nav.approve',
  'nav.audit',
  // workflow actions
  'action.approve',
  'action.edit',
  'action.reject',
  'action.requestChanges',
  'action.openTrace',
  'action.retry',
  'action.pause',
  'action.publish',
  'action.duplicate',
  'action.archive',
  // states
  'state.pending',
  'state.granted',
  'state.denied',
  'state.expired',
  'state.superseded',
  'state.approved',
  'state.scheduled',
  'state.published',
  'state.failed',
  'state.halted',
  'state.queued',
  // counts
  'queue.pendingCount',
  'queue.dueToday',
  'queue.empty',
  'channels.activeCount',
  'ops.runningCount',
  // errors
  'error.generic',
  'error.notFound',
  'error.noPermission',
  'error.rateLimited',
  'error.providerUnavailable',
  'error.validation',
  'error.budgetExceeded',
  'error.halt',
  'error.network',
  'error.unknownState',
  // labels
  'label.channel',
  'label.source',
  'label.run',
  'label.revision',
  'label.cost',
  'label.status',
  'label.updatedAt',
  'label.locale',
  // misc / confirmations
  'confirm.approveRun',
  'confirm.rejectRun',
  'dialog.requestChangesPrompt',
  'trace.openLabel',
  'time.justNow',
  'time.minutesAgo',
  'time.hoursAgo',
  'part.postMarker',
] as const;

export type EnKey = (typeof enKeys)[number];

export const enCatalog: Record<EnKey, string> = {
  // nav
  'nav.today': 'Today',
  'nav.queue': 'Queue',
  'nav.channels': 'Channels',
  'nav.ops': 'Ops',
  'nav.cost': 'Cost',
  'nav.settings': 'Settings',
  'nav.approve': 'Approve',
  'nav.audit': 'Audit log',

  // workflow actions
  'action.approve': 'Approve',
  'action.edit': 'Edit',
  'action.reject': 'Reject',
  'action.requestChanges': 'Request changes',
  'action.openTrace': 'Open trace',
  'action.retry': 'Retry',
  'action.pause': 'Pause',
  'action.publish': 'Publish now',
  'action.duplicate': 'Duplicate',
  'action.archive': 'Archive',

  // states
  'state.pending': 'Pending',
  'state.granted': 'Granted',
  'state.denied': 'Denied',
  'state.expired': 'Expired',
  'state.superseded': 'Superseded',
  'state.approved': 'Approved',
  'state.scheduled': 'Scheduled',
  'state.published': 'Published',
  'state.failed': 'Failed',
  'state.halted': 'Halted',
  'state.queued': 'Queued',

  // counts (plural)
  'queue.pendingCount':
    '{n, plural, one {# run awaiting approval} other {# runs awaiting approval}}',
  'queue.dueToday':
    '{n, plural, one {# post scheduled for today} other {# posts scheduled for today}}',
  'queue.empty': 'Queue is empty — nothing waiting on you.',
  'channels.activeCount':
    '{n, plural, one {# active channel} other {# active channels}}',
  'ops.runningCount':
    '{n, plural, one {# run in progress} other {# runs in progress}}',

  // errors
  'error.generic': 'Something went wrong. Please try again.',
  'error.notFound': 'The requested {thing} was not found.',
  'error.noPermission': 'You do not have permission to do that.',
  'error.rateLimited': 'Too many requests. Try again in {seconds} seconds.',
  'error.providerUnavailable': 'The provider is currently unavailable.',
  'error.validation': 'The form has {n, plural, one {# error} other {# errors}}. Please fix them and resubmit.',
  'error.budgetExceeded': 'This run would exceed the monthly budget of {amount}.',
  'error.halt': 'Publishing is halted. Unhalt from Settings to resume.',
  'error.network': 'Network request failed. Check your connection.',
  'error.unknownState': 'Unknown run state: {state}',

  // labels
  'label.channel': 'Channel',
  'label.source': 'Source',
  'label.run': 'Run',
  'label.revision': 'Revision',
  'label.cost': 'Cost',
  'label.status': 'Status',
  'label.updatedAt': 'Updated',
  'label.locale': 'Locale',

  // misc
  'confirm.approveRun': 'Approve run {id}?',
  'confirm.rejectRun': 'Reject run {id}? This cannot be undone.',
  'dialog.requestChangesPrompt': 'Describe what should change:',
  'trace.openLabel': 'Open trace',
  'time.justNow': 'just now',
  'time.minutesAgo': '{n, plural, one {# minute ago} other {# minutes ago}}',
  'time.hoursAgo': '{n, plural, one {# hour ago} other {# hours ago}}',
  'part.postMarker': 'Part {n}',
};

export function formatEn(key: EnKey, args: MessageArgs = {}): string {
  return formatMessage(enCatalog[key], 'en', args);
}
