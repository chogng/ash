import { Disposable, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { onDidChangeNls } from '../../../../../../nls.js';
import { IChatTipService } from '../../chatTipService.js';
import { ChatTipContentPart } from '../chatContentParts/chatTipContentPart.js';

export interface IChatInputTipPresenterOptions {
	readonly container: HTMLElement;
	readonly isEligible: () => boolean;
	readonly focusInput: () => void;
}

/** Applies the composer's notice eligibility without owning another copy of tip state. */
export class ChatInputTipPresenter extends Disposable {
	private readonly part = this._register(new MutableDisposable<ChatTipContentPart>());

	constructor(private readonly options: IChatInputTipPresenterOptions, @IChatTipService private readonly tips: IChatTipService) {
		super();
		this._register(tips.onDidDismissTip(() => this.update()));
		this._register(onDidChangeNls(() => {
			this.part.clear();
			this.update();
		}));
		this.update();
	}

	public get current(): ChatTipContentPart | undefined {
		return this.part.value;
	}

	public update(): void {
		const tip = this.options.isEligible() ? this.tips.getWelcomeTip() : undefined;
		if (!tip) {
			this.part.clear();
			return;
		}
		if (this.part.value) return;
		const part = new ChatTipContentPart(this.options.container.ownerDocument, tip, () => {
			this.options.focusInput();
			this.tips.dismissTip();
		});
		this.part.value = part;
		this.options.container.prepend(part.domNode);
	}
}
