import { env, l10n } from 'vscode';
export { Emitter, Disposable, DisposableStore, DisposableMap, toDisposable, CancellationToken, CancellationTokenSource, URI, extUriBiasedIgnorePathCase, observableFromEvent, Lxicon, SCMHistoryUnavailableError } from '../../../sdk/browser/index.js';
export type { IDecorationData, IDecorationsProvider, ISCMHistoryItemDetails, ISCMHistoryItem, ISCMHistoryItemChange, ISCMHistoryItemChangeContents, ISCMHistoryItemRef, ISCMHistoryOptions, ISCMHistoryProvider } from '../../../sdk/browser/index.js';
import type { URI } from '../../../sdk/browser/index.js';

export function localize(key: string | { key: string; bundle: string; }, message: string, ...args: readonly unknown[]): string { return l10n.t(message, ...args); }
export const isMacintosh = /Mac/.test(globalThis.navigator?.platform ?? '');
export function isRemoteResource(uri: URI): boolean { return uri.scheme === 'ash-remote'; }
export function getRemoteWorkspacePath(uri: URI): string { return uri.path; }
export class AppServerRemoteError extends Error { constructor(public readonly errorName: string, message: string) { super(message); } }
export interface LegacyConfiguration {
	inspect<T>(key: string): { userLocalValue: T | undefined; };
	updateValue(key: string, value: undefined): Promise<void>;
}
export interface ExtensionLog { error(category: string, message: string, error?: unknown): void; }
