import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export interface ISessionSectionOrderService {
	readonly onDidChange: Event<void>;
	getOrder(scope: string, visibleIds: readonly string[]): readonly string[];
	reorder(scope: string, visibleIds: readonly string[], id: string, targetId: string): void;
}

export const ISessionSectionOrderService = createServiceIdentifier<ISessionSectionOrderService>('sessionSectionOrderService');

const sectionOrderPrefix = 'sessions.list.sectionOrder.';

export class SessionSectionOrderService implements ISessionSectionOrderService {
	readonly onDidChange: Event<void>;

	constructor(@IStorageService private readonly storage: IStorageService) {
		this.onDidChange = (listener, thisArgs, disposables) => storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.startsWith(sectionOrderPrefix)) {
				listener.call(thisArgs);
			}
		}, undefined, disposables);
	}

	getOrder(scope: string, visibleIds: readonly string[]): readonly string[] {
		return resolveSectionOrder(readStoredOrder(this.storage, sectionOrderPrefix + scope), visibleIds);
	}

	reorder(scope: string, visibleIds: readonly string[], id: string, targetId: string): void {
		storeReorderedIds(this.storage, sectionOrderPrefix + scope, visibleIds, id, targetId);
	}
}

export function resolveSectionOrder(persisted: readonly string[], defaultOrderedIds: readonly string[]): string[] {
	const visible = new Set(defaultOrderedIds);
	return [...new Set([...persisted, ...defaultOrderedIds])].filter(id => visible.has(id));
}

export function readStoredOrder(storage: IStorageService, key: string): string[] {
	try {
		const value: unknown = JSON.parse(storage.get(key, StorageScope.PROFILE) ?? '[]');
		return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [];
	} catch {
		return [];
	}
}

export function storeReorderedIds(storage: IStorageService, key: string, visibleIds: readonly string[], id: string, targetId: string): void {
	const persisted = readStoredOrder(storage, key);
	const order = resolveSectionOrder(persisted, visibleIds);
	const from = order.indexOf(id);
	const to = order.indexOf(targetId);
	if (from < 0 || to < 0 || from === to) {
		return;
	}
	order.splice(from, 1);
	order.splice(to, 0, id);

	// Replace only the visible slots so a disconnected provider retains its ordering.
	const visible = new Set(visibleIds);
	const merged = [...new Set([...persisted, ...visibleIds])];
	let next = 0;
	const result = merged.map(entry => visible.has(entry) ? order[next++]! : entry);
	storage.store(key, JSON.stringify(result), StorageScope.PROFILE, StorageTarget.USER);
}
