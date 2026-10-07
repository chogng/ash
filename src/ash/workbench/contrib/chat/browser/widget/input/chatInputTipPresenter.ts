import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { IChatTipService } from '../../chatTipService.js';
import { ChatTipContentPart } from '../chatContentParts/chatTipContentPart.js';

export interface IChatInputTipPresenterOptions {
	readonly container: HTMLElement;
	readonly isEligible: () => boolean;
	readonly focusInput: () => void;
}

/** Applies the composer's notice eligibility without owning another copy of tip state. */
export class ChatInputTipPresenter extends Disposable {
	private readonly part = this._register(new MutableDisposable<DisposableStore>());
	private currentPart: ChatTipContentPart | undefined;

	constructor(private readonly options: IChatInputTipPresenterOptions, @IChatTipService private readonly tips: IChatTipService) {
		super();
		this._register(tips.onDidDismissTip(() => this.update()));
		this.update();
	}

	public get current(): ChatTipContentPart | undefined {
		return this.currentPart;
	}

	public update(): void {
		const tip = this.options.isEligible() ? this.tips.getWelcomeTip() : undefined;
		if (!tip) {
			this.part.clear();
			return;
		}
		if (this.part.value) return;
		const scope = new DisposableStore();
		this.part.value = scope;
		const parts = ChatTipContentPart.createObservable(scope, this.options.container.ownerDocument, tip, () => {
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
			if (hadFocus) {
				part.domNode.querySelector('button')?.focus();
			}
		};
		scope.add(parts.onDidChange(render));
		render(parts.get());
		scope.add(toDisposable(() => { this.currentPart = undefined; }));
	}
}
