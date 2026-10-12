import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isLinux, isWindows } from '../../../../../base/common/platform.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ITerminalService, type ITerminalContribution, type ITerminalInstance, type IXtermTerminal } from '../../../../services/terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';

import { TerminalCommandId } from '../../../terminal/common/terminal.js';
import { TerminalContextKeys, TerminalHasActiveInstanceContext } from '../../../terminal/common/terminalContextKey.js';

/** Clipboard operations retain their initiating instance across asynchronous host reads. */
export class TerminalClipboardContribution extends Disposable implements ITerminalContribution {
	public static readonly ID = 'terminal.clipboard';
	private screen: IXtermTerminal | undefined;
	private inputGeneration = 0;

	constructor(
		private readonly context: ITerminalContributionContext,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@ITerminalService private readonly terminals: ITerminalService,
	) {
		super();
		this._register(context.instance.onDidChangeState(() => this.inputGeneration++));
		this._register(context.instance.onDidExit(() => this.inputGeneration++));
		this._register(terminals.onDidChangeActiveInstance(() => this.inputGeneration++));
	}

	public static get(instance: ITerminalInstance): TerminalClipboardContribution | null {
		return instance.getContribution<TerminalClipboardContribution>(TerminalClipboardContribution.ID);
	}

	public xtermReady(screen: IXtermTerminal): void {
		this.screen = screen;
		const textarea = screen.raw.textarea!;
		const scope = this._register(this.contextKeys.createScoped(textarea));
		const selected = TerminalContextKeys.textSelectedInFocused.bindTo(scope);
		const updateSelection = (): void => selected.set(screen.raw.hasSelection() && textarea === textarea.ownerDocument.activeElement);
		updateSelection();
		const listener = screen.raw.onSelectionChange(updateSelection);
		this._register(toDisposable(() => listener.dispose()));
		this._register(addDisposableListener(textarea, 'focus', updateSelection));
		this._register(addDisposableListener(textarea, 'blur', () => selected.set(false)));
	}

	public async copySelection(): Promise<void> {
		const screen = this.screen;
		if (this.isDisposed || !screen || screen.isDisposed) return;
		const selection = screen.raw.getSelection();
		if (selection) await this.clipboard.writeText(selection);
	}

	public paste(): Promise<void> {
		return this.readAndPaste();
	}

	public pasteSelection(): Promise<void> {
		return this.readAndPaste('selection');
	}

	private async readAndPaste(type?: string): Promise<void> {
		const screen = this.screen;
		const instance = this.context.instance;
		const generation = this.inputGeneration;
		const canPaste = (): boolean => !this.isDisposed && !!screen && !screen.isDisposed
			&& generation === this.inputGeneration && instance.state === 'running' && !instance.isReadOnly
			&& this.terminals.activeInstance === instance && screen.element.isConnected && !screen.element.hidden;
		if (!canPaste()) return;
		const text = await this.clipboard.readText(type);
		if (!text || !canPaste()) return;
		screen!.focus();
		await instance.sendText(text, false, true);
	}

	protected override disposeCore(): void {
		this.inputGeneration++;
		this.screen = undefined;
		super.disposeCore();
	}
}

registerTerminalContribution(TerminalClipboardContribution.ID, TerminalClipboardContribution);

const selected = ContextKeyExpr.and(TerminalContextKeys.focus.isEqualTo(true), TerminalContextKeys.textSelectedInFocused.isEqualTo(true));

registerAction2(class TerminalCopySelectionAction extends Action2 {
	constructor() {
		super({
			id: TerminalCommandId.CopySelection,
			title: localize2('terminal.clipboard.copy', 'Terminal: Copy Selection'),
			f1: true,
			precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyC, mac: { primary: KeyMod.CtrlCmd | KeyCode.KeyC }, when: selected, weight: KeybindingWeight.WorkbenchContrib },
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const instance = accessor.get(ITerminalService).activeInstance;
		if (instance) await TerminalClipboardContribution.get(instance)?.copySelection();
	}
});

registerAction2(class TerminalCopyAndClearSelectionAction extends Action2 {
	constructor() {
		super({
			id: TerminalCommandId.CopyAndClearSelection,
			title: localize2('terminal.clipboard.copyAndClear', 'Terminal: Copy and Clear Selection'),
			f1: true,
			precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
			keybinding: isWindows ? { primary: KeyMod.CtrlCmd | KeyCode.KeyC, when: selected, weight: KeybindingWeight.WorkbenchContrib } : undefined,
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const instance = accessor.get(ITerminalService).activeInstance;
		const screen = instance?.xterm;
		if (!instance || !screen || screen.isDisposed) return;
		const contribution = TerminalClipboardContribution.get(instance);
		if (!contribution) return;
		const selection = screen.raw.getSelection();
		const position = screen.raw.getSelectionPosition();
		await contribution.copySelection();
		// A delayed clipboard write must not erase a newer selection.
		if (screen.isDisposed) return;
		const current = screen.raw.getSelectionPosition();
		if (screen.raw.getSelection() === selection && current?.start.x === position?.start.x && current?.start.y === position?.start.y
			&& current?.end.x === position?.end.x && current?.end.y === position?.end.y) screen.raw.clearSelection();
	}
});

registerAction2(class TerminalPasteAction extends Action2 {
	constructor() {
		super({
			id: TerminalCommandId.Paste,
			title: localize2('terminal.clipboard.paste', 'Terminal: Paste into Active Terminal'),
			f1: true,
			precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyV,
				linux: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV },
				win: { primary: KeyMod.CtrlCmd | KeyCode.KeyV, secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV] },
				when: TerminalContextKeys.focus.isEqualTo(true), weight: KeybindingWeight.WorkbenchContrib,
			},
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const instance = accessor.get(ITerminalService).activeInstance;
		if (instance) await TerminalClipboardContribution.get(instance)?.paste();
	}
});

if (isLinux) {
	registerAction2(class TerminalPasteSelectionAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.PasteSelection,
				title: localize2('terminal.clipboard.pasteSelection', 'Terminal: Paste Selection into Active Terminal'),
				f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: { primary: KeyMod.Shift | KeyCode.Insert, when: TerminalContextKeys.focus.isEqualTo(true), weight: KeybindingWeight.WorkbenchContrib },
			});
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const instance = accessor.get(ITerminalService).activeInstance;
			if (instance) await TerminalClipboardContribution.get(instance)?.pasteSelection();
		}
	});
}
