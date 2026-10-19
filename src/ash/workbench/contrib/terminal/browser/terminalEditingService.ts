import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ITerminalService, type ITerminalEditingService, type ITerminalInstance } from './terminal.js';

/** Owns the temporary rename interaction; the instance owns the resulting title. */
export class TerminalEditingService extends Disposable implements ITerminalEditingService {
	private editing: ITerminalInstance | undefined;
	private current: CancellationTokenSource | undefined;
	constructor(@ITerminalService private readonly terminals: ITerminalService, @IQuickInputService private readonly quickInput: IQuickInputService) { super(); }
	getEditingTerminal(): ITerminalInstance | undefined { return this.editing; }

	async rename(instance: ITerminalInstance): Promise<void> {
		if (!instance.rename || !this.terminals.instances.includes(instance) || this.isDisposed) return;
		this.current?.cancel();
		using lifetime = new DisposableStore();
		const cancellation = lifetime.add(new CancellationTokenSource());
		this.current = cancellation;
		this.editing = instance;
		lifetime.add(this.terminals.onDidDisposeInstance(closed => { if (closed === instance) cancellation.cancel(); }));
		try {
			const title = await this.quickInput.input({
				title: localize('terminal.rename.title', 'Rename Terminal'), value: instance.title,
				placeHolder: localize('terminal.rename.placeholder', 'Enter a terminal name; leave empty to restore the shell name'),
				validateInput: async value => value.length > 256 || /[\x00-\x1f\x7f]/.test(value)
					? localize('terminal.rename.invalid', 'Use at most 256 characters without control characters.') : undefined,
			}, cancellation.token);
			if (title !== undefined && !cancellation.token.isCancellationRequested && this.terminals.instances.includes(instance)) await instance.rename(title);
		} finally {
			if (this.current === cancellation) {
				this.current = undefined;
				this.editing = undefined;
				// A newer picker owns focus once the rename prompt has closed.
				if (!this.isDisposed && !this.quickInput.currentQuickInput && this.terminals.activeInstance === instance && this.terminals.instances.includes(instance) && !instance.xterm?.isDisposed) instance.xterm?.focus();
			}
		}
	}

	protected override disposeCore(): void { this.current?.cancel(); this.editing = undefined; super.disposeCore(); }
}
