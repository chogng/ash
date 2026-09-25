import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { Disposable } from '../../../base/common/lifecycle.js';
import { DialogResult, type IDialogOutcome } from '../common/dialogs.js';
import type { NativeDialogOperation } from '../../native/common/nativeHost.js';

/** Owns the in-flight system dialogs requested by one renderer window. */
export class WindowDialogHost extends Disposable {
	private readonly active = new Map<number, AbortController>();

	constructor(
		private readonly window: BrowserWindow,
		private readonly showMessageBox: (window: BrowserWindow, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>,
	) { super(); }

	public async perform(operation: NativeDialogOperation): Promise<IDialogOutcome | void> {
		this.assertNotDisposed();
		if (operation.kind === 'cancel') {
			this.active.get(operation.id)?.abort();
			return;
		}
		if (this.active.has(operation.id)) throw new Error('Dialog ID is already active');
		const request = operation.request;
		if (request.kind === 'input') throw new TypeError('Input dialogs are handled in the renderer');
		const controller = new AbortController();
		this.active.set(operation.id, controller);
		const buttons = request.kind === 'message'
			? [request.primaryButton ?? 'OK']
			: request.kind === 'confirmation'
				? [request.primaryButton ?? 'Confirm', request.cancelButton ?? 'Cancel']
				: [request.primaryButton, request.secondaryButton, request.cancelButton ?? 'Cancel'];
		try {
			const result = await this.showMessageBox(this.window, {
				type: request.kind === 'message' ? request.severity : 'question',
				title: request.title,
				message: request.message,
				detail: request.detail,
				buttons,
				checkboxLabel: request.checkbox?.label,
				checkboxChecked: request.checkbox?.checked,
				cancelId: buttons.length - 1,
				defaultId: 0,
				signal: controller.signal,
			});
			if (controller.signal.aborted || result.response === buttons.length - 1 && request.kind !== 'message') {
				return { button: DialogResult.Cancel, checkboxChecked: result.checkboxChecked };
			}
			return { button: result.response === 0 ? DialogResult.Primary : DialogResult.Secondary, checkboxChecked: result.checkboxChecked };
		} catch (error) {
			if (controller.signal.aborted) return { button: DialogResult.Cancel };
			throw error;
		} finally {
			this.active.delete(operation.id);
		}
	}

	protected override disposeCore(): void {
		for (const controller of this.active.values()) controller.abort();
		this.active.clear();
		super.disposeCore();
	}
}
