import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { isLinux, isWindows } from '../../../../../base/common/platform.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ITerminalService, type ITerminalContribution, type ITerminalInstance, type IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';

import { TerminalCommandId } from '../../../terminal/common/terminal.js';
import { TerminalContextKeys, TerminalHasActiveInstanceContext } from '../../../terminal/common/terminalContextKey.js';
import { shouldPasteTerminalText } from './terminalClipboard.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalSettingId } from '../../../../../platform/terminal/common/terminal.js';
import { InstanceContext } from '../../../terminal/browser/terminalContextMenu.js';
import { MarshalledId } from '../../../../../base/common/marshallingIds.js';

/** Clipboard operations retain their initiating instance across asynchronous host reads. */
export class TerminalClipboardContribution extends Disposable implements ITerminalContribution {
	public static readonly ID = 'terminal.clipboard';
	private screen: IXtermTerminal | undefined;
	private inputGeneration = 0;
	private focusGeneration = 0;

	constructor(
		private readonly context: ITerminalContributionContext,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@ITerminalService private readonly terminals: ITerminalService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IDialogService private readonly dialogs: IDialogService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@INotificationService private readonly notifications: INotificationService,
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
		const updateMouseOptions = (): void => {
			screen.raw.options.rightClickSelectsWord = this.configuration.getValue<string>(TerminalSettingId.RightClickBehavior) === 'selectWord';
		};
		updateMouseOptions();
		this._register(
			this.configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(TerminalSettingId.RightClickBehavior)) updateMouseOptions();
			}),
		);
		this._register(
			screen.onDidRequestRunCommand(async ({ command, noNewLine }) => {
				const generation = this.inputGeneration;
				const instance = this.context.instance;
				const current = (): boolean =>
					!this.isDisposed &&
					!screen.isDisposed &&
					this.inputGeneration === generation &&
					instance.state === 'running' &&
					!instance.isReadOnly &&
					this.terminals.activeInstance === instance &&
					instance.capabilities?.get(TerminalCapability.CommandDetection)?.commands.includes(command) === true;
				if (!command.command || !current()) return;
				try {
					if (!command.isTrusted) {
						const result = await this.dialogs.confirm({
							message: localize('terminal.command.confirmRerun', 'Run this command again?'),
							detail: command.command,
							primaryButton: localize('terminal.command.confirmRun', 'Run'),
						});
						if (!result.confirmed || !current()) return;
					}
					screen.focus();
					await instance.sendText(command.command, !noNewLine);
				} catch (error) {
					onUnexpectedError(error);
				}
			}),
		);
		const textarea = screen.raw.textarea!;
		const scope = this._register(this.contextKeys.createScoped(textarea));
		const selected = TerminalContextKeys.textSelectedInFocused.bindTo(scope);
		const updateSelection = (): void => selected.set(screen.raw.hasSelection() && textarea === textarea.ownerDocument.activeElement);
		updateSelection();
		const listener = screen.raw.onSelectionChange(() => {
			updateSelection();
			if (
				this.configuration.getValue<boolean>(TerminalSettingId.CopyOnSelection) &&
				this.terminals.activeInstance === this.context.instance &&
				textarea === textarea.ownerDocument.activeElement
			) {
				void this.copySelection().catch(error => {
					if (!this.isDisposed) this.notifications.error(error);
				});
			}
		});
		this._register(toDisposable(() => listener.dispose()));
		this._register(addDisposableListener(textarea, 'focus', updateSelection));
		this._register(
			addDisposableListener(textarea, 'blur', () => {
				this.focusGeneration++;
				selected.set(false);
			}),
		);
		// Capture before xterm can change the selection on right click. Shift and
		// keyboard context menus retain their normal menu path.
		const isScreenTarget = (event: MouseEvent): boolean => !(event.target as Element | null)?.closest?.('.ash-terminal-widget-overlay, [role="button"], button, a');
		this._register(
			addDisposableListener(
				screen.element,
				'mousedown',
				(event: MouseEvent) => {
					if (!isScreenTarget(event) || !this.shouldHandleRightClick(event)) return;
					event.preventDefault();
					event.stopImmediatePropagation();
					void this.handleMouseEvent(event).catch(error => {
						if (!this.isDisposed) this.notifications.error(error);
					});
				},
				true,
			),
		);
		this._register(
			addDisposableListener(
				screen.element,
				'contextmenu',
				(event: MouseEvent) => {
					if (!isScreenTarget(event) || event.button !== 2 || event.shiftKey) return;
					const behavior = this.configuration.getValue<string>(TerminalSettingId.RightClickBehavior);
					if (behavior === 'copyPaste' || behavior === 'paste' || behavior === 'nothing') {
						event.preventDefault();
						event.stopImmediatePropagation();
					}
				},
				true,
			),
		);
		// xterm listens on both its textarea and root. Capture before either handler
		// so browser-menu paste uses the same confirmation and acknowledged input path.
		this._register(
			addDisposableListener(
				screen.element,
				'paste',
				(event: ClipboardEvent) => {
					event.preventDefault();
					event.stopImmediatePropagation();
					void this.readAndPaste(undefined, event.clipboardData?.getData('text/plain') ?? '').catch(onUnexpectedError);
				},
				true,
			),
		);
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

	private shouldHandleRightClick(event: MouseEvent): boolean {
		const behavior = this.configuration.getValue<string>(TerminalSettingId.RightClickBehavior);
		return event.button === 2 && !event.shiftKey && (behavior === 'copyPaste' || behavior === 'paste');
	}

	public async handleMouseEvent(event: MouseEvent): Promise<{ handled: boolean } | void> {
		const screen = this.screen;
		if (!this.shouldHandleRightClick(event) || this.isDisposed || !screen || screen.isDisposed) return;
		const instance = this.context.instance;
		if (this.terminals.activeInstance !== instance) this.terminals.setActiveInstance(instance);
		screen.focus();
		if (this.configuration.getValue<string>(TerminalSettingId.RightClickBehavior) === 'copyPaste' && screen.raw.hasSelection()) {
			const selection = screen.raw.getSelection();
			const position = screen.raw.getSelectionPosition();
			const generation = this.inputGeneration;
			const focusGeneration = this.focusGeneration;
			await this.copySelection();
			const current = screen.isDisposed ? undefined : screen.raw.getSelectionPosition();
			// A failed write, a newer selection or a switch to another terminal must
			// leave the selection intact, so a retry cannot destroy uncopied text.
			if (
				!this.isDisposed &&
				!screen.isDisposed &&
				generation === this.inputGeneration &&
				focusGeneration === this.focusGeneration &&
				screen.raw.getSelection() === selection &&
				current?.start.x === position?.start.x &&
				current?.start.y === position?.start.y &&
				current?.end.x === position?.end.x &&
				current?.end.y === position?.end.y
			)
				screen.raw.clearSelection();
		} else {
			await this.readAndPaste(undefined, undefined, true);
		}
		return { handled: true };
	}

	private async readAndPaste(type?: string, suppliedText?: string, requireFocus = false): Promise<void> {
		const screen = this.screen;
		const instance = this.context.instance;
		const generation = this.inputGeneration;
		const focusGeneration = this.focusGeneration;
		const canPaste = (): boolean =>
			!this.isDisposed &&
			!!screen &&
			!screen.isDisposed &&
			generation === this.inputGeneration &&
			instance.state === 'running' &&
			!instance.isReadOnly &&
			this.terminals.activeInstance === instance &&
			screen.element.isConnected &&
			!screen.element.hidden;
		if (!canPaste()) return;
		const text = suppliedText ?? (await this.clipboard.readText(type));
		if (!text || !canPaste() || (requireFocus && focusGeneration !== this.focusGeneration)) return;
		const decision = await this.instantiation.invokeFunction(shouldPasteTerminalText, text, screen!.raw.modes.bracketedPasteMode);
		if (!canPaste()) return;
		screen!.focus();
		if (decision === false) return;
		const pasteText = typeof decision === 'object' ? decision.modifiedText : text;
		if (pasteText) await instance.sendText(pasteText, false, true);
	}

	protected override disposeCore(): void {
		this.inputGeneration++;
		this.screen = undefined;
		super.disposeCore();
	}
}

registerTerminalContribution(TerminalClipboardContribution.ID, TerminalClipboardContribution);

// Copy follows the focused textarea's selection, including retained output after exit.
const selected = TerminalContextKeys.textSelectedInFocused.isEqualTo(true);

/** Explicit menu targets never fall back to a different active terminal. */
function clipboardInstance(accessor: ServicesAccessor, context: unknown): ITerminalInstance | undefined {
	const terminals = accessor.get(ITerminalService);
	if (context === undefined) return terminals.activeInstance;
	const id =
		context instanceof InstanceContext
			? context.instanceId
			: context && typeof context === 'object' && '$mid' in context && context.$mid === MarshalledId.TerminalContext && 'instanceId' in context
				? context.instanceId
				: undefined;
	if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
		throw new TypeError(localize('terminal.context.invalid', 'Invalid terminal instance context'));
	}
	const instance = terminals.instances.find(instance => instance.instanceId === id);
	if (!instance) throw new Error(localize('terminal.context.closed', 'This terminal has been closed'));
	return instance;
}

registerAction2(
	class TerminalCopySelectionAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.CopySelection,
				title: localize2('terminal.clipboard.copy', 'Terminal: Copy Selection'),
				f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyC,
					mac: { primary: KeyMod.CtrlCmd | KeyCode.KeyC },
					when: selected,
					weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		public override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
			const instance = clipboardInstance(accessor, context);
			if (instance) await TerminalClipboardContribution.get(instance)?.copySelection();
		}
	},
);

registerAction2(
	class TerminalCopyAndClearSelectionAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.CopyAndClearSelection,
				title: localize2('terminal.clipboard.copyAndClear', 'Terminal: Copy and Clear Selection'),
				f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: isWindows
					? {
							primary: KeyMod.CtrlCmd | KeyCode.KeyC,
							when: selected,
							weight: KeybindingWeight.WorkbenchContrib,
						}
					: undefined,
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
			if (
				screen.raw.getSelection() === selection &&
				current?.start.x === position?.start.x &&
				current?.start.y === position?.start.y &&
				current?.end.x === position?.end.x &&
				current?.end.y === position?.end.y
			)
				screen.raw.clearSelection();
		}
	},
);

registerAction2(
	class TerminalPasteAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.Paste,
				title: localize2('terminal.clipboard.paste', 'Terminal: Paste into Active Terminal'),
				f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyCode.KeyV,
					linux: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV },
					win: {
						primary: KeyMod.CtrlCmd | KeyCode.KeyV,
						secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV],
					},
					when: TerminalContextKeys.focus.isEqualTo(true),
					weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		public override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
			const instance = clipboardInstance(accessor, context);
			if (!instance) return;
			if (context !== undefined) accessor.get(ITerminalService).setActiveInstance(instance);
			await TerminalClipboardContribution.get(instance)?.paste();
		}
	},
);

if (isLinux) {
	registerAction2(
		class TerminalPasteSelectionAction extends Action2 {
			constructor() {
				super({
					id: TerminalCommandId.PasteSelection,
					title: localize2('terminal.clipboard.pasteSelection', 'Terminal: Paste Selection into Active Terminal'),
					f1: true,
					precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
					keybinding: {
						primary: KeyMod.Shift | KeyCode.Insert,
						when: TerminalContextKeys.focus.isEqualTo(true),
						weight: KeybindingWeight.WorkbenchContrib,
					},
				});
			}
			public override async run(accessor: ServicesAccessor): Promise<void> {
				const instance = accessor.get(ITerminalService).activeInstance;
				if (instance) await TerminalClipboardContribution.get(instance)?.pasteSelection();
			}
		},
	);
}
