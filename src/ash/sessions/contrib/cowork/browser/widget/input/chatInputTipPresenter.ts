import { Disposable, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { IChatTipService } from '../../chatTipService.js';
import { ChatTipContentPart } from '../chatContentParts/chatTipContentPart.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ChatInputNoticeHost, ChatInputNoticeLane } from '../../../../../../workbench/contrib/chat/browser/widget/input/notices/chatInputNoticeHost.js';
import { registerChatInputNoticeAccessibleViews } from '../../../../../../workbench/contrib/chat/browser/widget/input/notices/chatInputNoticeWidget.js';

export interface IChatInputTipPresenterOptions {
	readonly container: HTMLElement;
	readonly isEligible: () => boolean;
	readonly focusInput: () => void;
}

/** Applies the composer's notice eligibility without owning another copy of tip state. */
export class ChatInputTipPresenter extends Disposable {
	private readonly part = this._register(new MutableDisposable<ChatTipContentPart>());
	private readonly claim = this._register(new MutableDisposable());

	constructor(private readonly options: IChatInputTipPresenterOptions, private readonly noticeHost: ChatInputNoticeHost, @IChatTipService private readonly tips: IChatTipService, @IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		this.options.container.hidden = true;
		this._register(registerChatInputNoticeAccessibleViews(this.options.container));
		this._register(tips.onDidDismissTip(() => this.update()));
		this.update();
	}

	public get current(): ChatTipContentPart | undefined {
		return this.part.value;
	}

	public update(): void {
		const tip = this.options.isEligible() ? this.tips.getWelcomeTip() : undefined;
		if (!tip) {
			this.claim.clear();
			this.part.clear();
			return;
		}
		if (this.part.value) return;
		const part = this.instantiation.createInstance(ChatTipContentPart, this.options.container.ownerDocument, tip, () => {
			this.options.focusInput();
			this.tips.dismissTip();
		});
		this.part.value = part;
		part.domNode.tabIndex = -1;
		this.options.container.prepend(part.domNode);
		this.claim.value = this.noticeHost.occupy(ChatInputNoticeLane.Tip, {
			focusTarget: {
				hasFocus: () => part.domNode.contains(this.options.container.ownerDocument.activeElement),
				focus: () => part.domNode.focus(),
				canFocus: () => !this.options.container.hidden,
			},
			onDidChangeLeading: leading => this.options.container.hidden = !leading,
		});
	}
}
