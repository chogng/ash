import { Disposable } from "../../../../base/common/lifecycle.js";
import {
	type IConfirmationDialogOptions,
	type IDialogService,
	type IMessageDialogOptions,
	type IPromptDialogOptions,
	DialogResult,
} from "../../../../platform/dialogs/common/dialogs.js";
import { DialogsModel } from "../../../common/dialogs.js";

/**
 * Maps the platform dialog API onto the workbench-owned dialog model.
 */
export class DialogService extends Disposable
	implements IDialogService {
	readonly model = this._register(new DialogsModel());

	async showMessage(options: IMessageDialogOptions): Promise<void> {
		const handle = this.model.show({
			kind: "message",
			...options,
		});
		await handle.result;
	}

	async confirm(options: IConfirmationDialogOptions): Promise<boolean> {
		const handle = this.model.show({
			kind: "confirmation",
			...options,
		});
		return await handle.result === DialogResult.Primary;
	}

	prompt(options: IPromptDialogOptions): Promise<DialogResult> {
		return this.model.show({
			kind: "prompt",
			...options,
		}).result;
	}
}
