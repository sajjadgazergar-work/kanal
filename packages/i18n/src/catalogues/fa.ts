/**
 * Persian (fa) catalogue (plan §14.8). ICU MessageFormat.
 * Persian uses CLDR `one`/`other` — it is not the Arabic six-form system.
 */
import type { MessageArgs } from '../message-format.js';
import { formatMessage } from '../message-format.js';

/** Catalogue keys — must stay in sync with en.ts. */
export const faKeys = [
  'nav.today',
  'nav.queue',
  'nav.channels',
  'nav.ops',
  'nav.cost',
  'nav.settings',
  'nav.approve',
  'nav.audit',
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
  'queue.pendingCount',
  'queue.dueToday',
  'queue.empty',
  'channels.activeCount',
  'ops.runningCount',
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
  'label.channel',
  'label.source',
  'label.run',
  'label.revision',
  'label.cost',
  'label.status',
  'label.updatedAt',
  'label.locale',
  'confirm.approveRun',
  'confirm.rejectRun',
  'dialog.requestChangesPrompt',
  'trace.openLabel',
  'time.justNow',
  'time.minutesAgo',
  'time.hoursAgo',
  'part.postMarker',
] as const;

export type FaKey = (typeof faKeys)[number];

export const faCatalog: Record<FaKey, string> = {
  // nav
  'nav.today': 'امروز',
  'nav.queue': 'صف انتشار',
  'nav.channels': 'کانال‌ها',
  'nav.ops': 'اجراها',
  'nav.cost': 'هزینه',
  'nav.settings': 'تنظیمات',
  'nav.approve': 'تأیید',
  'nav.audit': 'گزارش رویدادها',

  // workflow actions
  'action.approve': 'تأیید',
  'action.edit': 'ویرایش',
  'action.reject': 'رد کردن',
  'action.requestChanges': 'درخواست تغییر',
  'action.openTrace': 'باز کردن مسیر',
  'action.retry': 'تلاش دوباره',
  'action.pause': 'توقف موقت',
  'action.publish': 'انتشار الآن',
  'action.duplicate': 'تکرار',
  'action.archive': 'بایگانی',

  // states
  'state.pending': 'در انتظار',
  'state.granted': 'تأیید شده',
  'state.denied': 'رد شده',
  'state.expired': 'منقضی شده',
  'state.superseded': 'جایگزین شده',
  'state.approved': 'تأیید شده',
  'state.scheduled': 'زمان‌بندی شده',
  'state.published': 'منتشر شده',
  'state.failed': 'ناموفق',
  'state.halted': 'متوقف',
  'state.queued': 'در صف',

  // counts (plural: fa uses one/other)
  'queue.pendingCount':
    '{n, plural, one {# اجرا در انتظار تأیید} other {# اجرا در انتظار تأیید}}',
  'queue.dueToday':
    '{n, plural, one {# پست برای امروز زمان‌بندی شده} other {# پست برای امروز زمان‌بندی شده}}',
  'queue.empty': 'صف انتشار خالی است — چیزی در انتظار شما نیست.',
  'channels.activeCount':
    '{n, plural, one {# کانال فعال} other {# کانال فعال}}',
  'ops.runningCount':
    '{n, plural, one {# اجرا در حال انجام} other {# اجرا در حال انجام}}',

  // errors
  'error.generic': 'خطایی رخ داد. دوباره تلاش کنید.',
  'error.notFound': '{thing} پیدا نشد.',
  'error.noPermission': 'شما اجازه انجام این کار را ندارید.',
  'error.rateLimited': 'درخواست‌ها زیاد است. {seconds} ثانیه دیگر دوباره تلاش کنید.',
  'error.providerUnavailable': 'سرویس‌دهنده در حال حاضر در دسترس نیست.',
  'error.validation': 'فرم {n, plural, one {# خطا} other {# خطا}} دارد. آن‌ها را اصلاح و دوباره ارسال کنید.',
  'error.budgetExceeded': 'این اجرا از بودجه ماهانه {amount} فراتر می‌رود.',
  'error.halt': 'انتشار متوقف است. برای ادامه از تنظیمات خارج کنید.',
  'error.network': 'ارتباط برقرار نشد. اتصال خود را بررسی کنید.',
  'error.unknownState': 'وضعیت ناشناخته اجرا: {state}',

  // labels
  'label.channel': 'کانال',
  'label.source': 'منبع',
  'label.run': 'اجرا',
  'label.revision': 'نسخه',
  'label.cost': 'هزینه',
  'label.status': 'وضعیت',
  'label.updatedAt': 'به‌روزرسانی',
  'label.locale': 'زبان',

  // misc
  'confirm.approveRun': 'اجرای {id} تأیید شود؟',
  'confirm.rejectRun': 'اجرای {id} رد شود؟ این کار قابل بازگشت نیست.',
  'dialog.requestChangesPrompt': 'تغییرات موردنظر را بنویسید:',
  'trace.openLabel': 'باز کردن مسیر',
  'time.justNow': 'همین حالا',
  'time.minutesAgo': '{n, plural, one {# دقیقه پیش} other {# دقیقه پیش}}',
  'time.hoursAgo': '{n, plural, one {# ساعت پیش} other {# ساعت پیش}}',
  'part.postMarker': 'بخش {n}',
};

export function formatFa(key: FaKey, args: MessageArgs = {}): string {
  return formatMessage(faCatalog[key], 'fa', args);
}
