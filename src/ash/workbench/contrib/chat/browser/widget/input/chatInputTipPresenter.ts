import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { equals } from '../../../../../../base/common/objects.js';
import { IChatTipService, type IChatTip } from '../../chatTipService.js';
import { ChatTipContentPart } from '../chatContentParts/chatTipContentPart.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ChatInputNoticeHost, ChatInputNoticeLane } from './chatInputNoticeHost.js';
import { registerChatInputNoticeAccessibleViews } from './chatInputNoticeWidget.js';
import { chatInputStackSlotClass, ChatInputStackSlot, setChatInputStackSlot } from './chatInputStack.js';

export interface IChatInputTipPresenterOptions {
	readonly container: HTMLElement;
	readonly isEligible: () => boolean;
	readonly focusInput: () => void;
}

/** Applies the composer's notice eligibility without owning another copy of tip state. */
export class ChatInputTipPresenter extends Disposable {
	private readonly part = this._register(new MutableDisposable<DisposableStore>());
	private currentPart: ChatTipContentPart | undefined;
	private currentTip: IChatTip | undefined;
	private readonly claim = this._register(new MutableDisposable());
	private leading = false;

	constructor(private readonly options: IChatInputTipPresenterOptions, private readonly noticeHost: ChatInputNoticeHost, @IChatTipService private readonly tips: IChatTipService, @IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		this.options.container.classList.add(chatInputStackSlotClass);
		this.options.container.hidden = true;
		setChatInputStackSlot(this.options.container, ChatInputStackSlot.Empty);
		this._register(registerChatInputNoticeAccessibleViews(this.options.container, this.options.focusInput));
		this._register(toDisposable(() => {
			this.options.container.hidden = true;
			setChatInputStackSlot(this.options.container, ChatInputStackSlot.Empty);
		}));
		this._register(tips.onDidChangeTips(() => this.update()));
		this.update();
	}

	public get current(): ChatTipContentPart | undefined {
		return this.currentPart;
	}

	public update(): void {
		const eligible = this.options.isEligible();
		const tip = eligible ? this.tips.getWelcomeTip() : undefined;
		if (!tip) {
			if (eligible && this.currentPart?.domNode.contains(this.options.container.ownerDocument.activeElement)) this.options.focusInput();
			this.claim.clear();
			this.part.clear();
			return;
		}
		if (this.currentTip?.id === tip.id && equals({ ...this.currentTip.content }, { ...tip.content })) return;
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
		const hadFocus = this.currentPart?.domNode.contains(this.options.container.ownerDocument.activeElement);
		const scope = new DisposableStore();
		this.part.value = scope;
		this.currentTip = tip;
		const parts = ChatTipContentPart.instantiateObservable(this.instantiation, scope, this.options.container.ownerDocument, tip, () => {
			this.options.focusInput();
			this.tips.dismissTip(tip.id);
		});
		const render = (part: ChatTipContentPart): void => {
			const previous = this.currentPart;
			const replacingFocusedPart = previous?.domNode.contains(this.options.container.ownerDocument.activeElement);
			if (previous?.domNode.parentNode === this.options.container) {
				previous.domNode.replaceWith(part.domNode);
			} else {
				this.options.container.prepend(part.domNode);
			}
			this.currentPart = part;
			part.domNode.tabIndex = -1;
			if (replacingFocusedPart) {
				part.domNode.querySelector('button')?.focus();
			}
		};
		scope.add(parts.onDidChange(render));
		render(parts.get());
		if (hadFocus) this.currentPart?.domNode.querySelector<HTMLElement>('a, button')?.focus();
		scope.add(toDisposable(() => {
			this.currentPart = undefined;
			this.currentTip = undefined;
		}));
	}
}
