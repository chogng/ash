import { DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import type { IQuickPick, IQuickPickItem, IQuickPickItemButton, IQuickPickSeparator } from '../common/quickInput.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../storage/common/storage.js';

/** Pins store identities only. Missing catalog entries must never be revived from persistence. */
export function showWithPinnedItems<T extends IQuickPickItem>(storageService: IStorageService, storageKey: string, quickPick: IQuickPick<T>, filterDuplicates = false): IDisposable {
	const lifetime = new DisposableStore();
	const source = quickPick.items;
	const sortByLabel = quickPick.sortByLabel;
	const originals = new Map<T, T>();
	const pin: IQuickPickItemButton = { id: 'quickInput.pin', label: localize('quickInput.pin', 'Pin item'), iconClass: 'ash-icon-pin' };
	const unpin: IQuickPickItemButton = { id: 'quickInput.unpin', label: localize('quickInput.unpin', 'Unpin item'), iconClass: 'ash-icon-pinned' };
	let projection: readonly (T | IQuickPickSeparator)[] = source;
	const displayIdentity = (item: IQuickPickItem): string => JSON.stringify([item.label, item.description ?? '', item.detail ?? '']);
	const identity = (item: T): string => item.id || displayIdentity(item);
	const items = source.filter((item): item is T => !('type' in item));
	const read = (): string[] => {
		try {
			const value: unknown = JSON.parse(storageService.get(storageKey, StorageScope.WORKSPACE) ?? '[]');
			if (!Array.isArray(value)) return [];
			return value.flatMap(entry => {
				if (typeof entry === 'string') return [entry];
				// Accept older label-based pins at the persistence boundary, then use
				// the current catalog's identity without reviving a removed task.
				if (!entry || typeof entry !== 'object' || typeof entry.label !== 'string'
					|| entry.description !== undefined && typeof entry.description !== 'string'
					|| entry.detail !== undefined && typeof entry.detail !== 'string') return [];
				const candidate = items.find(item => displayIdentity(item) === displayIdentity(entry));
				return [candidate ? identity(candidate) : displayIdentity(entry)];
			});
		} catch {
			return [];
		}
	};
	const render = (): void => {
		const active = quickPick.activeItems[0];
		const activeSource = active && (originals.get(active) ?? active);
		const keys = read();
		originals.clear();
		const decorate = (item: T, pinned: boolean): T => {
			const buttons = (item.buttons ?? []).filter(button => button.id !== pin.id && button.id !== unpin.id
				&& button.iconClass !== pin.iconClass && button.iconClass !== unpin.iconClass);
			const row = { ...item, buttons: [pinned ? unpin : pin, ...buttons] };
			originals.set(row, item);
			return row;
		};
		const seen = new Set<string>();
		const favorites = quickPick.value ? [] : keys.flatMap(key => {
			if (filterDuplicates && seen.has(key)) return [];
			seen.add(key);
			const item = items.find(candidate => identity(candidate) === key);
			return item ? [decorate(item, true)] : [];
		});
		const rest = source.map(item => 'type' in item ? item : decorate(item, false));
		projection = !favorites.length ? rest : [
			{ type: 'separator', label: localize('quickInput.pinned', 'Pinned'), presentation: 'section' },
			...favorites,
			{ type: 'separator' },
			...rest,
		];
		quickPick.sortByLabel = quickPick.value ? sortByLabel : false;
		quickPick.items = projection;
		const retained = activeSource && [...originals].find(([, item]) => item === activeSource)?.[0];
		if (retained) quickPick.activeItems = [retained];
	};
	lifetime.add(quickPick.onDidTriggerItemButton(({ item, button }) => {
		if (button !== pin && button !== unpin) return;
		const selection = quickPick.valueSelection;
		const key = identity(originals.get(item) ?? item);
		const keys = button === pin ? [...read(), key] : read().filter(candidate => candidate !== key);
		storageService.store(storageKey, JSON.stringify(keys), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		render();
		// Reordering replaces the action button. Return keyboard focus to the
		// search field instead of leaving it on a detached row action.
		quickPick.focus();
		quickPick.valueSelection = selection;
	}));
	lifetime.add(quickPick.onDidChangeValue(render));
	lifetime.add(storageService.onDidChangeValue(event => {
		if (event.key === storageKey && event.scope === StorageScope.WORKSPACE) render();
	}));
	lifetime.add(toDisposable(() => originals.clear()));
	try {
		render();
		quickPick.show();
		return lifetime;
	} catch (error) {
		lifetime.dispose();
		throw error;
	}
}
