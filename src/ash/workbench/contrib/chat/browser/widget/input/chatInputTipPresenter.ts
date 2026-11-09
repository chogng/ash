import { status } from '../../../../../../base/browser/ui/aria/aria.js';
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
	readonly getSessionId?: () => string | undefined;
	readonly isEligible: () => boolean;
	readonly focusInput: () => void;
}

/** Applies the composer's notice eligibility without owning another copy of tip state. */
export class ChatInputTipPresenter extends Disposable {
	private readonly part = this._register(new MutableDisposable<DisposableStore>());
	private currentPart: ChatTipContentPart | undefined;
	private currentTip: IChatTip | undefined;
	private selectedTipId: string | undefined;
	private sessionId: string | undefined;
	private dismissedForSession = false;
	private canNavigate = false;
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
		this._register(tips.onDidChangeTips(change => {
			if (change === 'reset') {
				this.dismissedForSession = false;
				this.selectedTipId = undefined;
			}
			this.update();
		}));
		this.update();
	}

	public get current(): ChatTipContentPart | undefined {
		return this.currentPart;
	}

	public update(): void {
		const sessionId = this.options.getSessionId?.();
		if (sessionId !== this.sessionId) {
			this.sessionId = sessionId;
			this.dismissedForSession = false;
			this.selectedTipId = undefined;
		}
		const eligible = this.options.isEligible();
		const tip = eligible && !this.dismissedForSession ? this.tips.getWelcomeTip(this.selectedTipId) : undefined;
		if (!tip) {
			if (eligible && this.currentPart?.domNode.contains(this.options.container.ownerDocument.activeElement)) this.options.focusInput();
			this.selectedTipId = undefined;
			this.claim.clear();
			this.part.clear();
			return;
		}
		const canNavigate = this.tips.getWelcomeTip(tip.id, 1)?.id !== tip.id;
		if (this.currentTip?.id === tip.id && this.canNavigate === canNavigate && equals({ ...this.currentTip.content }, { ...tip.content })) return;
		if (!this.claim.value) {
			this.claim.value = this.noticeHost.occupy(ChatInputNoticeLane.Tip, {
				focusTarget: {
					hasFocus: () => this.currentPart?.domNode.contains(this.options.container.ownerDocument.activeElement) ?? false,
					focus: () => this.currentPart?.domNode.focus(),
					canFocus: () => this.leading && !!this.currentPart && !this.options.container.inert,
				},
				onDidChangeLeading: leading => {
					this.leading = leading;
					this.options.container.hidden = !leading;
					setChatInputStackSlot(this.options.container, leading ? ChatInputStackSlot.Standalone : ChatInputStackSlot.Empty);
				},
			});
		}
		this.renderTip(tip, canNavigate);
	}

	private renderTip(tip: IChatTip, canNavigate: boolean): void {
		const hadFocus = this.currentPart?.domNode.contains(this.options.container.ownerDocument.activeElement);
		const scope = new DisposableStore();
		this.part.value = scope;
		this.currentTip = tip;
		this.canNavigate = canNavigate;
		const navigation = canNavigate ? (direction: -1 | 1) => {
			const next = this.tips.getWelcomeTip(tip.id, direction);
			if (next) {
				this.selectedTipId = next.id;
				this.renderTip(next, canNavigate);
				this.currentPart?.focusNavigation(direction);
				status(this.currentPart?.domNode.querySelector('.ash-markdown')?.textContent ?? '');
			}
		} : undefined;
		const parts = ChatTipContentPart.instantiateObservable(this.instantiation, scope, this.options.container.ownerDocument, tip, () => {
			this.dismissedForSession = true;
			this.options.focusInput();
			this.tips.dismissTip(tip.id);
			this.update();
		}, navigation);
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
