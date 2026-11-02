import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatTipService } from '../../../chatTipService.js';
import { ChatTipContentPart } from '../../chatContentParts/chatTipContentPart.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { ChatInputNoticeHost, ChatInputNoticeLane } from './chatInputNoticeHost.js';
import { registerChatInputNoticeAccessibleViews } from './chatInputNoticeWidget.js';

import { chatInputStackSlotClass, ChatInputStackSlot, setChatInputStackSlot } from '../chatInputStack.js';

export interface IChatInputTipPresenterOptions {
	readonly container: HTMLElement;
	readonly isEligible: () => boolean;
	readonly focusInput: () => void;
}

/** Applies the composer's notice eligibility without owning another copy of tip state. */
export class ChatInputTipPresenter extends Disposable {
	private readonly part = this._register(new MutableDisposable<DisposableStore>());
	private currentPart: ChatTipContentPart | undefined;
	private readonly claim = this._register(new MutableDisposable());
	private leading = false;

	constructor(private readonly options: IChatInputTipPresenterOptions, private readonly noticeHost: ChatInputNoticeHost, @IChatTipService private readonly tips: IChatTipService, @IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		this.options.container.classList.add(chatInputStackSlotClass);
		this.options.container.hidden = true;
		setChatInputStackSlot(this.options.container, ChatInputStackSlot.Empty);
		this._register(registerChatInputNoticeAccessibleViews(this.options.container));
		this._register(toDisposable(() => {
			this.options.container.hidden = true;
			setChatInputStackSlot(this.options.container, ChatInputStackSlot.Empty);
		}));
		this._register(tips.onDidDismissTip(() => this.update()));
		this.update();
	}

	public get current(): ChatTipContentPart | undefined {
		return this.currentPart;
	}

	public update(): void {
		const tip = this.options.isEligible() ? this.tips.getWelcomeTip() : undefined;
		if (!tip) {
			this.claim.clear();
			this.part.clear();
			return;
		}
		if (!this.claim.value) {
			this.claim.value = this.noticeHost.occupy(ChatInputNoticeLane.Tip, {
				focusTarget: {
					hasFocus: () => this.currentPart?.domNode.contains(this.options.container.ownerDocument.activeElement) ?? false,
					focus: () => this.currentPart?.domNode.focus(),
					canFocus: () => this.leading && !!this.currentPart,
				},
				onDidChangeLeading: leading => {
					this.leading = leading;
					this.options.container.hidden = !leading;
					setChatInputStackSlot(this.options.container, leading ? ChatInputStackSlot.Standalone : ChatInputStackSlot.Empty);
				},
			});
		}
		if (this.part.value) return;
		const scope = new DisposableStore();
		this.part.value = scope;
		const parts = ChatTipContentPart.instantiateObservable(this.instantiation, scope, this.options.container.ownerDocument, tip, () => {
			this.options.focusInput();
			this.tips.dismissTip();
		});
		const render = (part: ChatTipContentPart): void => {
			const previous = this.currentPart;
			const hadFocus = previous?.domNode.contains(this.options.container.ownerDocument.activeElement);
			if (previous?.domNode.parentNode === this.options.container) {
				previous.domNode.replaceWith(part.domNode);
			} else {
				this.options.container.prepend(part.domNode);
			}
			this.currentPart = part;
			part.domNode.tabIndex = -1;
			if (hadFocus) {
				part.domNode.querySelector('button')?.focus();
			}
		};
		scope.add(parts.onDidChange(render));
		render(parts.get());
		scope.add(toDisposable(() => { this.currentPart = undefined; }));
	}
}
