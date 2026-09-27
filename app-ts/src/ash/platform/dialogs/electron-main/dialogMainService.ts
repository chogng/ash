import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { Disposable } from '../../../base/common/lifecycle.js';
import { DialogResult, type IDialogOutcome } from '../common/dialogs.js';
import type { NativeDialogOperation } from '../../native/common/nativeHost.js';
import { messageBoxOptions, messageBoxOutcome } from './dialogMainUtils.js';

/** Owns system dialogs and their cancellation for one renderer window. */
export class DialogMainService extends Disposable {
	private readonly active = new Map<number, AbortController>();

	constructor(
		private readonly window: BrowserWindow,
		private readonly showMessageBox: (window: BrowserWindow, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>,
	) { super(); }

	async perform(operation: NativeDialogOperation): Promise<IDialogOutcome | void> {
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
		try {
			const result = await this.showMessageBox(this.window, messageBoxOptions(request, controller.signal));
			return controller.signal.aborted ? { button: DialogResult.Cancel } : messageBoxOutcome(request, result);
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
