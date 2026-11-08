import { Lazy } from './lazy.js';

const defaultLanguage = 'en';

const timeAgoUnits = [
	{ unit: 'year', milliseconds: 365 * 86_400_000 },
	{ unit: 'month', milliseconds: 30 * 86_400_000 },
	{ unit: 'day', milliseconds: 86_400_000 },
	{ unit: 'hour', milliseconds: 3_600_000 },
	{ unit: 'minute', milliseconds: 60_000 },
] as const;

/** Formats elapsed time in whole units. Returns undefined for timestamps less than a minute old. */
export function formatTimeAgo(timestamp: number, now: number, formatter: Intl.RelativeTimeFormat): string | undefined {
	const elapsed = now - timestamp;
	const unit = timeAgoUnits.find(candidate => elapsed >= candidate.milliseconds);
	return unit ? formatter.format(-Math.floor(elapsed / unit.milliseconds), unit.unit) : undefined;
}

function guarded<T>(create: () => T, createDefault: () => T): Lazy<T> {
	return new Lazy(() => {
		try { return create(); }
		catch { return createDefault(); }
	});
}

/** Lazily creates Intl objects and rejects invalid locale input at one shared boundary. */
export const safeIntl = Object.freeze({
	DateTimeFormat(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions): Lazy<Intl.DateTimeFormat> {
		return guarded(() => new Intl.DateTimeFormat(locales, options), () => new Intl.DateTimeFormat(undefined, options));
	},
	Collator(locales?: Intl.LocalesArgument, options?: Intl.CollatorOptions): Lazy<Intl.Collator> {
		return guarded(() => new Intl.Collator(locales, options), () => new Intl.Collator(undefined, options));
	},
	Segmenter(locales?: Intl.LocalesArgument, options?: Intl.SegmenterOptions): Lazy<Intl.Segmenter> {
		return guarded(() => new Intl.Segmenter(locales, options), () => new Intl.Segmenter(undefined, options));
	},
	Locale(tag: Intl.Locale | string, options?: Intl.LocaleOptions): Lazy<Intl.Locale> {
		return guarded(() => new Intl.Locale(tag, options), () => new Intl.Locale(defaultLanguage, options));
	},
	NumberFormat(locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions): Lazy<Intl.NumberFormat> {
		return guarded(() => new Intl.NumberFormat(locales, options), () => new Intl.NumberFormat(undefined, options));
	},
});
