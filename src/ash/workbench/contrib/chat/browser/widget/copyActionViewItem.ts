import { ButtonActionViewItem, type ActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { Button, IButtonOptions } from '../../../../../base/browser/ui/button/button.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';

export interface CopyActionOperation {
	readonly run: () => unknown;
	readonly isCurrent?: () => boolean;
	readonly onSuccess: () => void;
	readonly onError: (error: unknown) => void;
}

/** Shows copy feedback on the existing button after the clipboard write succeeds. */
export class CopyActionViewItem extends ButtonActionViewItem {
	private copying = false;
	private readonly clearFeedback = this._register(new RunOnceScheduler(() => this.setCopied(false), 1200));

	constructor(
		action: IAction,
		options: ActionViewItemOptions,
		private readonly resolveOperation?: () => CopyActionOperation | undefined,
		private readonly size?: IButtonOptions['size'],
	) {
		super(action, options);
	}

	protected override createButton(container: HTMLElement, options: IButtonOptions): Button {
		return super.createButton(container, { ...options, size: this.size ?? options.size });
	}

	protected getCopyOperation(): CopyActionOperation | undefined {
		return this.resolveOperation?.();
	}

	protected override async runAction(): Promise<void> {
		if (this.copying) return;
		const operation = this.getCopyOperation();
		if (!operation || operation.isCurrent?.() === false) return;

		this.copying = true;
		this.button.domNode.setAttribute('aria-busy', 'true');
		this.clearFeedback.cancel();
		this.setCopied(false);
		try {
			await operation.run();
			if (this.isDisposed || operation.isCurrent?.() === false) return;
			this.setCopied(true);
			this.clearFeedback.schedule();
			operation.onSuccess();
		} catch (error) {
			if (!this.isDisposed && operation.isCurrent?.() !== false) operation.onError(error);
		} finally {
			this.copying = false;
			if (!this.isDisposed) this.button.domNode.removeAttribute('aria-busy');
		}
	}

	private setCopied(copied: boolean): void {
		this.button.icon = copied ? Lxicon.check : this.action.icon;
		this.button.toggleClassName('ash-copy-action-succeeded', copied);
	}
}
