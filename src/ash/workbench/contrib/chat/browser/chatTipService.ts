import { Emitter, type Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
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
	getWelcomeTip(): IChatTip | undefined;
	dismissTip(id: string): void;
}

export interface IChatTipProvider {
	readonly onDidChange: Event<void>;
	provideTip(): IChatTip | undefined;
	dismissTip(id: string): void;
}

export const IChatTipService = createServiceIdentifier<IChatTipService>('chatTipService');
const DismissedTipStorageKey = 'chat.dismissedWelcomeTip';
const AttachmentTipId = 'attach-files';

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

	public getWelcomeTip(): IChatTip | undefined {
		for (const provider of this.providers) {
			const tip = provider.provideTip();
			if (tip) return tip;
		}
		if (this.dismissedTip.get() === AttachmentTipId) return undefined;
		return {
			id: AttachmentTipId,
			content: new MarkdownString(localize('chat.tip.attachFiles', 'Tip: Attach text files or images with the + button. You can also paste or drop images into your message.')),
		};
	}

	public dismissTip(id: string): void {
		if (id === AttachmentTipId) {
			this.dismissedTip.set(AttachmentTipId);
			return;
		}
		for (const provider of this.providers) provider.dismissTip(id);
	}
}
