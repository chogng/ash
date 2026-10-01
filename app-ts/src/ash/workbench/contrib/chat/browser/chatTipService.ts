import { Emitter, type Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { observableMemento, type ObservableMemento } from '../../../../platform/observable/common/observableMemento.js';

export interface IChatTip {
	readonly id: string;
	readonly content: MarkdownString;
}

export interface IChatTipService {
	readonly onDidDismissTip: Event<void>;
	getWelcomeTip(): IChatTip | undefined;
	dismissTip(): void;
}

export const IChatTipService = createServiceIdentifier<IChatTipService>('chatTipService');
const DismissedTipStorageKey = 'chat.dismissedWelcomeTip';
const AttachmentTipId = 'attach-files';

/** Owns welcome-tip eligibility and the user's profile-scoped dismissal. */
export class ChatTipService extends Disposable implements IChatTipService {
	private readonly dismissed = this._register(new Emitter<void>());
	public readonly onDidDismissTip = this.dismissed.event;
	private readonly dismissedTip: ObservableMemento<string>;

	constructor(@IStorageService storage: IStorageService) {
		super();
		this.dismissedTip = this._register(observableMemento({
			key: DismissedTipStorageKey,
			defaultValue: '',
			toStorage: (value: string) => value,
			fromStorage: (value: string) => value,
		})(StorageScope.PROFILE, StorageTarget.USER, storage));
		this._register(this.dismissedTip.onDidChange(() => this.dismissed.fire()));
	}

	public getWelcomeTip(): IChatTip | undefined {
		if (this.dismissedTip.get() === AttachmentTipId) return undefined;
		return {
			id: AttachmentTipId,
			content: new MarkdownString(localize('chat.tip.attachFiles', 'Tip: Attach text files or images with the + button. You can also paste or drop images into your message.')),
		};
	}

	public dismissTip(): void {
		this.dismissedTip.set(AttachmentTipId);
	}
}
