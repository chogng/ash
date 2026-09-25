import { environment } from '../../../../base/common/platform.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDialogHandler, IDialogOutcome } from '../../../../platform/dialogs/common/dialogs.js';
import { IDialogsModel, IWorkbenchDialogHandler, type IDialogViewItem } from '../../../common/dialogs.js';
import { registerWorkbenchContribution, WorkbenchPhase, type IWorkbenchContribution } from '../../../common/contributions.js';

type DialogPresentationOutcome =
	| { readonly kind: 'result'; readonly result: IDialogOutcome }
	| { readonly kind: 'error'; readonly error: unknown };

/** Presents a window's dialog requests in queue order. */
export class DialogHandlerContribution extends Disposable implements IWorkbenchContribution {
	private active: { readonly item: IDialogViewItem; readonly controller: AbortController } | undefined;

	constructor(private readonly model: IDialogsModel, private readonly handler: IDialogHandler) {
		super();
		this._register(toDisposable(() => {
			const active = this.active;
			this.active = undefined;
			active?.controller.abort();
			active?.item.cancel();
		}));
		this._register(model.onDidCloseDialog(({ item }) => {
			if (this.active?.item === item) this.active.controller.abort();
		}));
		this._register(model.onWillShowDialog(() => this.processDialogs()));
		this.processDialogs();
	}

	private processDialogs(): void {
		if (this.isDisposed || this.active) return;
		const item = this.model.dialogs[0];
		if (!item) return;
		const active = { item, controller: new AbortController() };
		this.active = active;
		void this.show(active);
	}

	private async show(active: { readonly item: IDialogViewItem; readonly controller: AbortController }): Promise<void> {
		let outcome: DialogPresentationOutcome;
		try {
			outcome = {
				kind: 'result',
				result: await this.handler.showDialog(active.item.request, active.controller.signal),
			};
		} catch (error) {
			outcome = { kind: 'error', error };
		}
		if (this.active !== active) return;
		this.active = undefined;
		try {
			if (outcome.kind === 'result') active.item.close(outcome.result);
			else active.item.fail(outcome.error);
		} finally {
			this.processDialogs();
		}
	}
}

if (environment.runtime !== 'electron') {
	registerWorkbenchContribution(
		'workbench.contrib.dialogHandler',
		WorkbenchPhase.BlockStartup,
		accessor => new DialogHandlerContribution(
			accessor.get(IDialogsModel),
			accessor.get(IWorkbenchDialogHandler),
		),
	);
}
