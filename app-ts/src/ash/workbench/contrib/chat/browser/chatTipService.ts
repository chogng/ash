import { Emitter, type Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

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

	constructor(@IStorageService private readonly storage: IStorageService) {
		super();
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key === DismissedTipStorageKey) this.dismissed.fire();
		}));
	}

	public getWelcomeTip(): IChatTip | undefined {
		if (this.storage.get(DismissedTipStorageKey, StorageScope.PROFILE) === AttachmentTipId) return undefined;
		return {
			id: AttachmentTipId,
			content: new MarkdownString(localize('chat.tip.attachFiles', 'Tip: Attach text files or images with the + button. You can also paste or drop images into your message.')),
		};
	}

	public dismissTip(): void {
		this.storage.store(DismissedTipStorageKey, AttachmentTipId, StorageScope.PROFILE, StorageTarget.USER);
	}
}
