import "./media/quickInput.css";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { QuickInputController } from "../../../../platform/quickinput/browser/quickInputController.js";
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
	private readonly controller: QuickInputController;
	private readonly inQuickInput: IContextKey<boolean>;
	private readonly layoutService: ILayoutService | undefined;

	constructor(options: WorkbenchQuickInputServiceOptions) {
		super();
		const container = options.layoutService?.activeContainer ?? options.container;
		this.layoutService = options.layoutService;
		this.inQuickInput =
			InQuickInputContext.bindTo(options.contextKeyService);
		this.controller = this._register(new QuickInputController(container));
		this._register(this.controller.onShow(() => this.inQuickInput.set(true)));
		this._register(this.controller.onHide(() => this.inQuickInput.reset()));
		this._register(toDisposable(() => this.inQuickInput.reset()));
		this.updateLayout();
		if (this.layoutService) {
			this._register(this.layoutService.onDidLayoutActiveContainer(() => this.updateLayout()));
		}
	}

	createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem> {
		return this.controller.createQuickPick<TItem>();
	}

	private updateLayout(): void {
		const quickInputTop = this.layoutService?.activeContainerOffset.quickInputTop ?? 0;
		const dimension = this.layoutService?.activeContainerDimension ?? { width: 0, height: 0 };
		this.controller.layout(dimension, quickInputTop);
	}
}
