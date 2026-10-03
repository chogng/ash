export type LocalizationParameters = Readonly<Record<string, string | number>>;

/** Stable bundle/key metadata that can be consumed without Workbench services. */
export interface LocalizationKey {
	readonly bundle: string;
	readonly key: string;
}

export interface ILocalizeInfo {
	readonly key: string;
	readonly comment: string[];
}

export interface ILocalizedString {
	readonly original: string;
	readonly value: string;
}

type LocalizeArgument = string | number | boolean | undefined | null;

export type NlsResolver = (
	bundle: string,
	key: string,
	fallback: string,
	parameters?: LocalizationParameters,
) => string;

let language = 'en';
const fallbackResolver: NlsResolver = (_bundle, _key, fallback, parameters) =>
	formatNlsMessage(fallback, parameters);
let resolver: NlsResolver = fallbackResolver;

export function getNLSLanguage(): string { return language; }

/** Bootstrap must finish before importing modules that register translated metadata. */
export function setNlsMessages(locale: string, bundles: Readonly<Record<string, Readonly<Record<string, string>>>>): void {
	language = locale;
	resolver = (bundle, key, original, parameters) => formatNlsMessage(bundles[bundle]?.[key] ?? original, parameters);
}

export function localize(info: ILocalizeInfo, message: string, ...args: LocalizeArgument[]): string;
export function localize(info: LocalizationKey, message: string, ...args: LocalizeArgument[]): string;
export function localize(key: string, message: string, ...args: LocalizeArgument[]): string;
export function localize(info: ILocalizeInfo | LocalizationKey | string, message: string, ...args: LocalizeArgument[]): string {
	const key = typeof info === "string" ? info : info.key;
	const bundle = typeof info === "string" || !("bundle" in info) ? "ash" : info.bundle;
	const parameters = args.length === 0 ? undefined : Object.fromEntries(args.map((value, index) => [String(index), String(value)]));
	return resolver(bundle, key, message, parameters);
}

export function localize2(info: ILocalizeInfo, message: string, ...args: LocalizeArgument[]): ILocalizedString;
export function localize2(info: LocalizationKey, message: string, ...args: LocalizeArgument[]): ILocalizedString;
export function localize2(key: string, message: string, ...args: LocalizeArgument[]): ILocalizedString;
export function localize2(info: ILocalizeInfo | LocalizationKey | string, message: string, ...args: LocalizeArgument[]): ILocalizedString {
	const original = formatNlsMessage(message, Object.fromEntries(args.map((value, index) => [String(index), String(value)])));
	return {
		original,
		value: localize(info as string, message, ...args),
	};
}

/** Installs the resolver for the current renderer realm. */
export function setNlsResolver(next: NlsResolver): void {
	resolver = next;
}

/** Restores source-language fallback behavior for isolated tests and hosts. */
export function resetNlsResolver(): void {
	resolver = fallbackResolver;
	language = 'en';
}

export function formatNlsMessage(
	message: string,
	parameters: LocalizationParameters | undefined,
): string {
	if (!parameters) return message;
	return message.replaceAll(/\{([A-Za-z0-9_.-]+)\}/gu, (placeholder, key: string) => {
		const value = parameters[key];
		return value === undefined ? placeholder : String(value);
	});
}
