import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import {
	type DialogResult,
	type IDialogHandler,
} from "../../../../platform/dialogs/common/dialogs.js";
import {
	IDialogsModel,
	type IDialogViewItem,
	IWorkbenchDialogHandler,
} from "../../../common/dialogs.js";
import {
	type IWorkbenchContribution,
	registerWorkbenchContribution,
	WorkbenchPhase,
} from "../../../common/contributions.js";

interface IActiveDialog {
	readonly item: IDialogViewItem;
	readonly controller: AbortController;
}

type DialogPresentationOutcome =
	| {
		readonly kind: "result";
		readonly result: DialogResult;
	}
	| {
		readonly kind: "error";
		readonly error: unknown;
	};

/**
 * Serially presents the queue owned by the workbench dialog service.
 */
export class DialogHandlerContribution extends Disposable
	implements IWorkbenchContribution {
	private readonly model: IDialogsModel;
	private readonly handler: IDialogHandler;
	private active: IActiveDialog | undefined;

	constructor(model: IDialogsModel, handler: IDialogHandler) {
		super();
		this.model = model;
		this.handler = handler;
		this._register(toDisposable(() => {
			const active = this.active;
			this.active = undefined;
			active?.controller.abort();
			active?.item.cancel();
		}));
		this._register(model.onDidCloseDialog(({ item }) => {
			if (this.active?.item === item) {
				this.active.controller.abort();
			}
		}));
		this._register(model.onWillShowDialog(() => this.processDialogs()));
		this.processDialogs();
	}

	private processDialogs(): void {
		if (this.isDisposed || this.active) return;
		const item = this.model.dialogs[0];
		if (!item) return;

		const active: IActiveDialog = {
			item,
			controller: new AbortController(),
		};
		this.active = active;
		void this.show(active);
	}

	private async show(active: IActiveDialog): Promise<void> {
		let outcome: DialogPresentationOutcome;
		try {
			outcome = {
				kind: "result",
				result: await this.handler.showDialog(
					active.item.request,
					active.controller.signal,
				),
			};
		} catch (handlerError) {
			outcome = { kind: "error", error: handlerError };
		}

		if (this.active !== active) return;
		this.active = undefined;
		try {
			if (outcome.kind === "result") {
				active.item.close(outcome.result);
			} else {
				active.item.fail(outcome.error);
			}
		} finally {
			this.processDialogs();
		}
	}
}

registerWorkbenchContribution(
	"workbench.contrib.dialogHandler",
	WorkbenchPhase.BlockStartup,
	(accessor) => new DialogHandlerContribution(
		accessor.get(IDialogsModel),
		accessor.get(IWorkbenchDialogHandler),
	),
);
