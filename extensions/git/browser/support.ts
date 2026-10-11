import translated from '../package.nls.zh-CN.json' with { type: 'json' };
let language = 'en';
export function setLanguage(value: string): void { language = value; }
export { Emitter, Disposable, DisposableStore, DisposableMap, toDisposable, CancellationToken, CancellationTokenSource, URI, extUriBiasedIgnorePathCase, observableFromEvent, Lxicon, SCMHistoryUnavailableError } from '../../../sdk/browser/index.js';
export type { IDecorationData, IDecorationsProvider, ISCMHistoryItemDetails, ISCMHistoryItem, ISCMHistoryItemChange, ISCMHistoryItemChangeContents, ISCMHistoryItemRef, ISCMHistoryOptions, ISCMHistoryProvider } from '../../../sdk/browser/index.js';
import type { URI } from '../../../sdk/browser/index.js';

export function localize(key: string | { key: string; bundle: string; }, message: string, ...args: readonly unknown[]): string { const id = typeof key === 'string' ? key : key.key; const value = language.toLowerCase().startsWith('zh') ? (translated as Record<string, string>)[id] ?? message : message; return value.replace(/\{(\d+)\}/g, (match, index) => args[index] === undefined ? match : String(args[index])); }
export const isMacintosh = /Mac/.test(globalThis.navigator?.platform ?? '');
export { isRemoteResource, getRemoteWorkspacePath } from '../../../sdk/browser/index.js';
export class AppServerRemoteError extends Error { constructor(public readonly errorName: string, message: string) { super(message); } }
export interface LegacyConfiguration {
	inspect(key: string): { userLocalValue?: unknown; };
	updateValue(key: string, value: undefined): Promise<void>;
}
export interface ExtensionLog { error(category: string, message: string, error?: unknown): void; }

export { CancellationError } from '../../../sdk/browser/index.js';
