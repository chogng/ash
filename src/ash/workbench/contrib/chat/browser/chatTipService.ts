import { Emitter, type Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { TIP_CATALOG } from './chatTipCatalog.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export interface IChatTip {
	readonly id: string;
	readonly content: MarkdownString;
}

export interface IChatTipService {
	readonly onDidChangeTips: Event<void | 'reset'>;
	registerTipProvider(provider: IChatTipProvider): IDisposable;
	getWelcomeTip(currentId?: string, offset?: -1 | 0 | 1, allowedIds?: readonly string[]): IChatTip | undefined;
	dismissTip(id: string): void;
	clearDismissedTips(): void;
}

export interface IChatTipProvider {
	readonly onDidChange: Event<void>;
	provideTip(): IChatTip | undefined;
	dismissTip(id: string): void;
	clearDismissedTips?(): void;
}

export const IChatTipService = createServiceIdentifier<IChatTipService>('chatTipService');
const DismissedTipStoragePrefix = 'chat.dismissedCodeTip.';
const LegacyDismissedTipKey = 'chat.dismissedWelcomeTip';

/** Owns welcome-tip eligibility and the user's profile-scoped dismissal. */
export class ChatTipService extends Disposable implements IChatTipService {
	private readonly changed = this._register(new Emitter<void | 'reset'>());
	public readonly onDidChangeTips = this.changed.event;
	private readonly providers = new Set<IChatTipProvider>();
	constructor(@IStorageService private readonly storage: IStorageService) {
		super();
		const legacyDismissal = storage.get(LegacyDismissedTipKey, StorageScope.PROFILE);
		if (legacyDismissal !== undefined) {
			// Only the former attachment dismissal identifies a specific tip.
			if (legacyDismissal === 'attach-files') {
				storage.store(DismissedTipStoragePrefix + 'attach-files', true, StorageScope.PROFILE, StorageTarget.USER);
			}
			storage.remove(LegacyDismissedTipKey, StorageScope.PROFILE);
		}
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.startsWith(DismissedTipStoragePrefix)) this.changed.fire();
		}));
	}

	public registerTipProvider(provider: IChatTipProvider): IDisposable {
		const registration = this._register(new DisposableStore());
		this.providers.add(provider);
		registration.add(provider.onDidChange(() => this.changed.fire()));
		registration.add(toDisposable(() => {
			this.providers.delete(provider);
			this.changed.fire();
		}));
		this.changed.fire();
		return registration;
	}

	public getWelcomeTip(currentId?: string, offset: -1 | 0 | 1 = 0, allowedIds?: readonly string[]): IChatTip | undefined {
		const tips: IChatTip[] = [];
		for (const provider of this.providers) {
			const tip = provider.provideTip();
			if (tip && (!allowedIds || allowedIds.includes(tip.id))) tips.push(tip);
		}
		for (const tip of TIP_CATALOG) {
			if ((!allowedIds || allowedIds.includes(tip.id)) && !this.storage.getBoolean(DismissedTipStoragePrefix + tip.id, StorageScope.PROFILE, false)) {
				tips.push({ id: tip.id, content: new MarkdownString(tip.message()) });
			}
		}
		if (tips.length === 0) return undefined;
		const currentIndex = tips.findIndex(tip => tip.id === currentId);
		return currentIndex < 0 ? tips[0] : tips[(currentIndex + offset + tips.length) % tips.length];
	}

	public dismissTip(id: string): void {
		if (TIP_CATALOG.some(tip => tip.id === id)) {
			this.storage.store(DismissedTipStoragePrefix + id, true, StorageScope.PROFILE, StorageTarget.USER);
			return;
		}
		for (const provider of this.providers) provider.dismissTip(id);
	}

	public clearDismissedTips(): void {
		this.storage.remove(LegacyDismissedTipKey, StorageScope.PROFILE);
		for (const key of this.storage.keys(StorageScope.PROFILE, StorageTarget.USER)) {
			if (key.startsWith(DismissedTipStoragePrefix)) this.storage.remove(key, StorageScope.PROFILE);
		}
		for (const provider of this.providers) provider.clearDismissedTips?.();
		this.changed.fire('reset');
	}
}
