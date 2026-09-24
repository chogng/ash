import { isRecord } from '../../../base/common/types.js';

export type CompletionsEnablement = boolean | Readonly<Record<string, boolean>>;

/** Resolves an editor's explicit completion enablement before its wildcard value. */
export function isCompletionsEnabledFromObject(enablement: CompletionsEnablement | undefined, modeId = '*'): boolean {
	if (typeof enablement === 'boolean') return enablement;
	if (!isRecord(enablement)) return false;
	const explicit = Object.hasOwn(enablement, modeId) ? enablement[modeId] : undefined;
	if (typeof explicit === 'boolean') return explicit;
	return Object.hasOwn(enablement, '*') && enablement['*'] === true;
}

export function isCompletionsEnablement(value: unknown): value is CompletionsEnablement {
	return typeof value === 'boolean' || (isRecord(value) && Object.values(value).every(entry => typeof entry === 'boolean'));
}
