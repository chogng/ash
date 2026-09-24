import { Lazy } from './lazy.js';

const defaultLanguage = 'en';

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
