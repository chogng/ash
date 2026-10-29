import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import {
	TerminalCapability,
	type ITerminalCapabilityStore,
} from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import type { IPromptInputModel } from '../../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';

/** Exposes the shell's parsed input and cursor to a screen reader without sending input. */
export class TextAreaSyncAddon extends Disposable implements ITerminalAddon {
	private terminal: Terminal | undefined;
	private readonly inputListener = this._register(new MutableDisposable());

	constructor(
		private readonly capabilities: ITerminalCapabilityStore,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) {
		super();
		this._register(capabilities.onDidChangeCapabilities(() => this.refresh()));
		this._register(accessibility.onDidChangeScreenReaderOptimized(() => this.refresh()));
	}

	activate(terminal: Terminal): void {
		this.terminal = terminal;
		this.refresh();
	}

	private refresh(): void {
		this.inputListener.clear();
		const model = this.capabilities.get(TerminalCapability.CommandDetection)?.promptInputModel;
		const textarea = this.terminal?.textarea;
		if (!model || !textarea || !this.accessibility.isScreenReaderOptimized()) return;
		const sync = (): void => this.sync(textarea, model);
		this.inputListener.value = model.onDidChangeInput(sync);
		sync();
	}

	private sync(textarea: HTMLTextAreaElement, model: IPromptInputModel): void {
		// An unknown cursor is not an editable prompt (for example during execution).
		if (model.cursorIndex < 0) return;
		textarea.value = model.value;
		textarea.setSelectionRange(model.cursorIndex, model.cursorIndex);
	}
}
