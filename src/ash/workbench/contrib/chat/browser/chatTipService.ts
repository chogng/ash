import { Emitter, type Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { TIP_CATALOG } from './chatTipCatalog.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { observableMemento, type ObservableMemento } from '../../../../platform/observable/common/observableMemento.js';

export interface IChatTip {
	readonly id: string;
	readonly content: MarkdownString;
}

export interface IChatTipService {
	readonly onDidChangeTips: Event<void>;
	registerTipProvider(provider: IChatTipProvider): IDisposable;
	getWelcomeTip(currentId?: string, offset?: -1 | 0 | 1): IChatTip | undefined;
	dismissTip(id: string): void;
}

export interface IChatTipProvider {
	readonly onDidChange: Event<void>;
	provideTip(): IChatTip | undefined;
	dismissTip(id: string): void;
}

export const IChatTipService = createServiceIdentifier<IChatTipService>('chatTipService');
const DismissedTipStorageKey = 'chat.dismissedWelcomeTip';
const DismissedCatalogId = 'code-tip-catalog';

/** Owns welcome-tip eligibility and the user's profile-scoped dismissal. */
export class ChatTipService extends Disposable implements IChatTipService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeTips = this.changed.event;
	private readonly providers = new Set<IChatTipProvider>();
	private readonly dismissedTip: ObservableMemento<string>;

	constructor(@IStorageService storage: IStorageService) {
		super();
		this.dismissedTip = this._register(observableMemento({
			key: DismissedTipStorageKey,
			defaultValue: '',
			toStorage: (value: string) => value,
			fromStorage: (value: string) => value,
		})(StorageScope.PROFILE, StorageTarget.USER, storage));
		this._register(this.dismissedTip.onDidChange(() => this.changed.fire()));
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

	public getWelcomeTip(currentId?: string, offset: -1 | 0 | 1 = 0): IChatTip | undefined {
		const dismissed = this.dismissedTip.get();
		if (dismissed === DismissedCatalogId) return undefined;
		const tips: IChatTip[] = [];
		for (const provider of this.providers) {
			const tip = provider.provideTip();
			if (tip) tips.push(tip);
		}
		for (const tip of TIP_CATALOG) {
			// Older profiles stored the ID of the single built-in attachment tip.
			if (tip.id !== dismissed) tips.push({ id: tip.id, content: new MarkdownString(tip.message()) });
		}
		if (tips.length === 0) return undefined;
		const currentIndex = tips.findIndex(tip => tip.id === currentId);
		return currentIndex < 0 ? tips[0] : tips[(currentIndex + offset + tips.length) % tips.length];
	}

	public dismissTip(id: string): void {
		this.dismissedTip.set(DismissedCatalogId);
		if (TIP_CATALOG.some(tip => tip.id === id)) return;
		for (const provider of this.providers) provider.dismissTip(id);
	}
}
