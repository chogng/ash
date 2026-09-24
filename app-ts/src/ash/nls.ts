import { Emitter, type Event } from "./base/common/event.js";

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

const changes = new Emitter<void>();
const fallbackResolver: NlsResolver = (_bundle, _key, fallback, parameters) =>
	formatNlsMessage(fallback, parameters);
let resolver: NlsResolver = fallbackResolver;

/** Fires when the active renderer-wide NLS projection changes. */
export const onDidChangeNls: Event<void> = changes.event;

export function localize(info: ILocalizeInfo, message: string, ...args: LocalizeArgument[]): string;
export function localize(key: string, message: string, ...args: LocalizeArgument[]): string;
export function localize(info: ILocalizeInfo | string, message: string, ...args: LocalizeArgument[]): string {
	const key = typeof info === "string" ? info : info.key;
	return resolver("ash", key, formatNlsArguments(message, args));
}

export function localize2(info: ILocalizeInfo, message: string, ...args: LocalizeArgument[]): ILocalizedString;
export function localize2(key: string, message: string, ...args: LocalizeArgument[]): ILocalizedString;
export function localize2(info: ILocalizeInfo | string, message: string, ...args: LocalizeArgument[]): ILocalizedString {
	const original = formatNlsArguments(message, args);
	return {
		original,
		value: localize(info as string, message, ...args),
	};
}

/** Installs the resolver for the current renderer realm. */
export function setNlsResolver(next: NlsResolver): void {
	resolver = next;
	changes.fire();
}

/** Restores source-language fallback behavior for isolated tests and hosts. */
export function resetNlsResolver(): void {
	resolver = fallbackResolver;
	changes.fire();
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

function formatNlsArguments(message: string, args: readonly LocalizeArgument[]): string {
	return message.replaceAll(/\{(\d+)\}/gu, (placeholder, index: string) => {
		const numericIndex = Number(index);
		if (numericIndex >= args.length) return placeholder;
		return String(args[numericIndex]);
	});
}
