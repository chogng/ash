import { Emitter, type Event } from "../../base/common/event.js";
import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import {
	type DialogRequest,
	DialogResult,
	type IDialogHandler,
} from "../../platform/dialogs/common/dialogs.js";
import {
	createServiceIdentifier,
} from "../../platform/instantiation/common/instantiation.js";

/** One dialog exposed to a workbench dialog renderer. */
export interface IDialogViewItem {
	readonly request: DialogRequest;

	close(result: DialogResult): void;
	cancel(): void;
	fail(error: unknown): void;
}

/** Handle returned to the caller that enqueued a dialog. */
export interface IDialogHandle {
	readonly item: IDialogViewItem;
	readonly result: Promise<DialogResult>;
}

/** Change emitted after one dialog leaves the model. */
export type IDialogCloseEvent =
	| {
		readonly kind: "result";
		readonly item: IDialogViewItem;
		readonly result: DialogResult;
	}
	| {
		readonly kind: "error";
		readonly item: IDialogViewItem;
		readonly error: unknown;
	};

/**
 * Window-scoped dialog queue shared between dialog services and renderers.
 */
export interface IDialogsModel {
	readonly onWillShowDialog: Event<IDialogViewItem>;
	readonly onDidCloseDialog: Event<IDialogCloseEvent>;
	readonly dialogs: readonly IDialogViewItem[];

	show(request: DialogRequest): IDialogHandle;
}

/** Window-scoped dialog model owned by the workbench dialog service. */
export const IDialogsModel =
	createServiceIdentifier<IDialogsModel>("dialogsModel");

/** Host-specific dialog renderer consumed by the dialog contribution. */
export const IWorkbenchDialogHandler =
	createServiceIdentifier<IDialogHandler>("workbenchDialogHandler");

/**
 * Owns pending workbench dialogs without depending on browser presentation.
 */
export class DialogsModel
	extends Disposable
	implements IDialogsModel {
	private readonly _onWillShowDialog =
		this._register(new Emitter<IDialogViewItem>());
	private readonly _onDidCloseDialog =
		this._register(new Emitter<IDialogCloseEvent>());
	private readonly _dialogs: IDialogViewItem[] = [];

	readonly onWillShowDialog = this._onWillShowDialog.event;
	readonly onDidCloseDialog = this._onDidCloseDialog.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			for (const item of [...this._dialogs]) item.cancel();
		}));
	}

	get dialogs(): readonly IDialogViewItem[] {
		return [...this._dialogs];
	}

	show(request: DialogRequest): IDialogHandle {
		if (this.isDisposed) {
			throw new ReferenceError("DialogsModel is already disposed");
		}

		let resolveResult!: (result: DialogResult) => void;
		let rejectResult!: (error: unknown) => void;
		const result = new Promise<DialogResult>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		let settled = false;

		const item: IDialogViewItem = {
			request,
			close: (dialogResult) => {
				if (settled) return;
				settled = true;
				this.remove(item);
				resolveResult(dialogResult);
				this._onDidCloseDialog.fire({
					kind: "result",
					item,
					result: dialogResult,
				});
			},
			cancel: () => item.close(DialogResult.Cancel),
			fail: (error) => {
				if (settled) return;
				settled = true;
				this.remove(item);
				rejectResult(error);
				this._onDidCloseDialog.fire({ kind: "error", item, error });
			},
		};
		this._dialogs.push(item);
		this._onWillShowDialog.fire(item);
		return { item, result };
	}

	private remove(item: IDialogViewItem): void {
		const index = this._dialogs.indexOf(item);
		if (index >= 0) this._dialogs.splice(index, 1);
	}
}
