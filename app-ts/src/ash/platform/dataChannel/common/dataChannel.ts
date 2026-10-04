import { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { IObservable } from '../../../base/common/observable.js';
import type { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IDataChannelService = createDecorator<IDataChannelService>('dataChannelService');

export interface IDataChannelService {
	readonly _serviceBrand: undefined;
	readonly onDidSendData: Event<IDataChannelEvent>;
	getDataChannel<T>(channelId: string): CoreDataChannel<T>;
}

export interface CoreDataChannel<T = unknown> {
	sendData(data: T): void;
}

export interface IDataChannelEvent<T = unknown> {
	channelId: string;
	data: T;
}

export type LinkPresentationKind = 'resource' | 'issue' | 'pullRequest' | 'commit' | 'file' | 'folder' | 'session' | 'chat' | 'repository' | 'branch';
export type LinkPresentationStatusKind = 'neutral' | 'pending' | 'success' | 'warning' | 'error' | 'open' | 'closed' | 'merged' | 'draft' | 'notPlanned';

export interface ILinkPresentationStatus {
	readonly kind: LinkPresentationStatusKind;
	readonly label: string;
}

export interface ILinkPresentation {
	readonly kind: LinkPresentationKind;
	readonly title?: string;
	readonly detail?: string;
	readonly reference?: string;
	readonly status?: ILinkPresentationStatus;
	readonly secondaryStatus?: ILinkPresentationStatus;
	readonly changes?: { readonly insertions: number; readonly deletions: number };
	readonly tooltip?: string;
	readonly ariaLabel?: string;
	readonly isLoading?: boolean;
}

/** Normalizes an extension result before it enters frontend observables or DOM. */
export function parseLinkPresentation(value: unknown): ILinkPresentation {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new TypeError('Link presentation must be an object');
	}
	const input = value as Record<string, unknown>;
	const kinds: readonly string[] = ['resource', 'issue', 'pullRequest', 'commit', 'file', 'folder', 'session', 'chat', 'repository', 'branch'];
	if (typeof input.kind !== 'string' || !kinds.includes(input.kind)) {
		throw new TypeError('Link presentation kind is invalid');
	}
	const result: { -readonly [K in keyof ILinkPresentation]: ILinkPresentation[K] } = { kind: input.kind as LinkPresentationKind };
	for (const key of ['title', 'detail', 'reference', 'tooltip', 'ariaLabel'] as const) {
		if (input[key] !== undefined) {
			if (typeof input[key] !== 'string' || input[key].length > 4096) {
				throw new TypeError(`Link presentation ${key} is invalid`);
			}
			result[key] = input[key];
		}
	}
	for (const key of ['status', 'secondaryStatus'] as const) {
		if (input[key] !== undefined) {
			const status = input[key] as Partial<ILinkPresentationStatus> | null;
			const statusKinds: readonly string[] = ['neutral', 'pending', 'success', 'warning', 'error', 'open', 'closed', 'merged', 'draft', 'notPlanned'];
			if (typeof status !== 'object' || status === null || !statusKinds.includes(status.kind!) || typeof status.label !== 'string' || status.label.length > 4096) {
				throw new TypeError(`Link presentation ${key} is invalid`);
			}
			result[key] = Object.freeze({ kind: status.kind!, label: status.label });
		}
	}
	if (input.changes !== undefined) {
		const changes = input.changes as ILinkPresentation['changes'];
		if (!changes || !Number.isSafeInteger(changes.insertions) || changes.insertions < 0 || !Number.isSafeInteger(changes.deletions) || changes.deletions < 0) {
			throw new TypeError('Link presentation changes are invalid');
		}
		result.changes = Object.freeze({ insertions: changes.insertions, deletions: changes.deletions });
	}
	if (input.isLoading !== undefined) {
		if (typeof input.isLoading !== 'boolean') {
			throw new TypeError('Link presentation loading state is invalid');
		}
		result.isLoading = input.isLoading;
	}
	return Object.freeze(result);
}

export interface ILinkPresentationWatcher extends IDisposable {
	readonly presentation: IObservable<ILinkPresentation | undefined>;
}

export interface ILinkPresentationProvider {
	createLinkPresentationWatcher(resource: URI): ILinkPresentationWatcher;
}

export interface ILinkPresentationProviderRegistration {
	readonly id: string;
	readonly uriPattern: RegExp;
	readonly kind: LinkPresentationKind;
	readonly enablement?: string;
}

export interface ILinkPresentationRule {
	readonly id: string;
	readonly uriPattern: RegExp;
	readonly kind: LinkPresentationKind;
}

export const ILinkPresentationService = createDecorator<ILinkPresentationService>('linkPresentationService');

export interface ILinkPresentationService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeLinkPresentationRules: Event<void>;
	readonly linkPresentationRules: readonly ILinkPresentationRule[];
	registerLinkPresentationProvider(registration: ILinkPresentationProviderRegistration, provider: ILinkPresentationProvider): IDisposable;
	getLinkPresentationRule(resource: URI): ILinkPresentationRule | undefined;
	createLinkPresentationWatcher(providerId: string, resource: URI): ILinkPresentationWatcher | undefined;
}

/** Standalone editors have no extension host and deliberately do not publish data. */
export class NullDataChannelService implements IDataChannelService {
	public readonly _serviceBrand = undefined;
	public readonly onDidSendData = Event.None;
	public getDataChannel<T>(_channelId: string): CoreDataChannel<T> {
		return { sendData: () => {} };
	}
}
