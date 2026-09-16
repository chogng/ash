import "./media/quickInput.css";
import { addDisposableListener, isHTMLElement, stopEvent, h } from "../../../../base/browser/dom.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import {
	BrowserQuickPick,
	type IBrowserQuickPickHost,
} from "../../../../platform/quickinput/browser/quickPick.js";
import type {
	IQuickInputService,
	IQuickPick,
	IQuickPickItem,
} from "../../../../platform/quickinput/common/quickInput.js";
import type { IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type { ILayoutService } from "../../../../platform/layout/browser/layoutService.js";
import {
	InQuickInputContext,
} from "../../../browser/quickaccess.js";

export interface WorkbenchQuickInputServiceOptions {
	readonly container: HTMLElement;
	readonly contextKeyService: IContextKeyService;
	readonly layoutService?: ILayoutService;
}

/** Window-scoped host shared by every short-lived Quick Input controller. */
export class WorkbenchQuickInputService
	extends Disposable
	implements IQuickInputService {
	private readonly host: HTMLDivElement;
	private readonly ownerDocument: Document;
	private readonly inQuickInput: IContextKey<boolean>;
	private readonly layoutService: ILayoutService | undefined;
	private readonly quickPicks = new Set<IBrowserQuickPickHost>();
	private active: IBrowserQuickPickHost | undefined;
	private focusToRestore: HTMLElement | undefined;

	constructor(options: WorkbenchQuickInputServiceOptions) {
		super();
		const container = options.layoutService?.activeContainer ?? options.container;
		this.ownerDocument = container.ownerDocument;
		this.layoutService = options.layoutService;
		this.inQuickInput =
			InQuickInputContext.bindTo(options.contextKeyService);
		this.host = h(this.ownerDocument, "div");
		this.host.className = "ash-quick-input-host";
		this.host.hidden = true;
		container.append(this.host);
		this.updateLayout();
		if (this.layoutService) {
			this._register(this.layoutService.onDidLayoutActiveContainer(() => this.updateLayout()));
		}

		this._register(addDisposableListener(
			this.host,
			"mousedown",
			(event: MouseEvent) => {
				if (event.target !== this.host) return;
				stopEvent(event);
				this.active?.hide();
			},
		));
		this._register(toDisposable(() => {
			for (const quickPick of [...this.quickPicks]) {
				quickPick.dispose();
			}
			this.quickPicks.clear();
			this.active = undefined;
			this.focusToRestore = undefined;
			this.inQuickInput.reset();
			this.host.remove();
		}));
	}

	createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem> {
		let quickPick: BrowserQuickPick<TItem>;
		quickPick = new BrowserQuickPick<TItem>(this.host, {
			onShow: (candidate) => this.show(candidate),
			onHide: (candidate) => this.hide(candidate),
			onDispose: (candidate) => {
				this.quickPicks.delete(candidate);
				this.hide(candidate);
			},
		});
		this.quickPicks.add(quickPick);
		return quickPick;
	}

	private show(quickPick: IBrowserQuickPickHost): void {
		if (this.active === quickPick) {
			quickPick.focus();
			return;
		}
		this.active?.hide();
		const focused = this.ownerDocument.activeElement;
		this.focusToRestore = isHTMLElement(focused)
			? focused
			: undefined;
		this.active = quickPick;
		this.host.replaceChildren(quickPick.element);
		this.host.hidden = false;
		this.inQuickInput.set(true);
		quickPick.focus();
	}

	private hide(quickPick: IBrowserQuickPickHost): void {
		if (this.active !== quickPick) return;
		this.active = undefined;
		this.host.replaceChildren();
		this.host.hidden = true;
		this.inQuickInput.reset();
		const focusToRestore = this.focusToRestore;
		this.focusToRestore = undefined;
		if (focusToRestore?.isConnected) focusToRestore.focus();
	}

	private updateLayout(): void {
		const quickInputTop = this.layoutService?.activeContainerOffset.quickInputTop ?? 0;
		this.host.style.paddingTop = `${quickInputTop + 8}px`;
	}
}
