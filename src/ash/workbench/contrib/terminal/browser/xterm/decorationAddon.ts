import type { Terminal, ITerminalAddon, IMarker, IDecoration } from '@xterm/xterm';
import {
	Disposable,
	DisposableMap,
	DisposableStore,
	MutableDisposable,
	toDisposable,
} from '../../../../../base/common/lifecycle.js';
import {
	TerminalCapability,
	type IBufferMarkCapability,
	type ITerminalCommand,
} from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalCapabilityStore } from '../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import type { ITerminalCommandStatusEvent } from '../terminal.js';
import { getTerminalCommandDecorationTooltip, updateLayout } from './decorationStyles.js';
import { terminalDecorationIncomplete, terminalDecorationSuccess, terminalDecorationError } from '../terminalIcons.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { localize } from '../../../../../nls.js';
import { Emitter } from '../../../../../base/common/event.js';
import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { getHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import {
	TERMINAL_COMMAND_DECORATION_DEFAULT_BACKGROUND_COLOR,
	TERMINAL_COMMAND_DECORATION_SUCCESS_BACKGROUND_COLOR,
	TERMINAL_COMMAND_DECORATION_ERROR_BACKGROUND_COLOR,
} from '../../common/terminalColorRegistry.js';

interface ScreenCommand {
	readonly marker: IMarker;
	readonly decoration: IDecoration | undefined;
	event: ITerminalCommandStatusEvent | undefined;
}

/** Owns only screen positions and UI resources, not Shell history or capabilities. */
export class DecorationAddon extends Disposable implements ITerminalAddon {
	private terminal: Terminal | undefined;
	private readonly commands = new Map<string, ScreenCommand>();
	private readonly lifetimes = this._register(new DisposableMap<string, DisposableStore>());
	private marks: IBufferMarkCapability | undefined;
	private readonly runCommand = this._register(new Emitter<{ command: ITerminalCommand; noNewLine?: boolean }>());
	readonly onDidRequestRunCommand = this.runCommand.event;
	private menuCommand: ScreenCommand | undefined;
	get markers(): readonly IMarker[] {
		return [...(this.marks?.markers() ?? [])];
	}

	constructor(
		private readonly capabilities: TerminalCapabilityStore,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService private readonly themes: IThemeService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IContextMenuService private readonly menus: IContextMenuService,
	) {
		super();
		this._register(
			configuration.onDidChangeConfiguration(event => {
				const decorationChanged = event.affectsConfiguration(
					'terminal.integrated.shellIntegration.decorationsEnabled',
				);
				if (
					!decorationChanged &&
					!event.affectsConfiguration('terminal.integrated.fontSize') &&
					!event.affectsConfiguration('terminal.integrated.lineHeight')
				)
					return;
				for (const command of this.commands.values()) {
					if (decorationChanged) this.updateOverviewRuler(command);
					if (command.decoration?.element) this.render(command.decoration.element, command);
				}
			}),
		);
		this._register(
			themes.onDidColorThemeChange(() => {
				for (const command of this.commands.values()) this.updateOverviewRuler(command);
			}),
		);
		this._register(menus.onDidHideContextMenu(() => (this.menuCommand = undefined)));
	}

	activate(terminal: Terminal): void {
		this.lifetimes.clearAndDisposeAll();
		this.marks = this.capabilities.get(TerminalCapability.BufferMarkDetection);
		this.terminal = terminal;
	}

	registerCommandDecoration(
		event: ITerminalCommandStatusEvent | undefined,
		processId: number,
		suppliedMarker: IMarker,
	): void {
		const terminal = this.terminal;
		if (!terminal || !this.marks || this.isDisposed) return;
		// Shell integration may assign its execution ID after the prompt appears.
		// The screen marker stays stable across pending, execution and completion.
		const key = `${processId}:${suppliedMarker.id}`;
		let command = this.commands.get(key);
		if (!command) {
			this.marks.addMark({ id: key, marker: suppliedMarker });
			const marker = this.marks.getMark(key);
			if (!marker) return;
			const lifetime = new DisposableStore();
			const decoration = terminal.registerDecoration({
				marker,
				width: 1,
				layer: 'top',
				overviewRulerOptions: this.overviewRulerOptions(event),
			});
			command = { marker, decoration, event };
			this.commands.set(key, command);
			this.lifetimes.set(key, lifetime);
			// Trim/clear must release callbacks immediately, not at screen shutdown.
			lifetime.add(toDisposable(() => this.commands.delete(key)));
			lifetime.add(
				toDisposable(() => {
					if (this.menuCommand === command) this.menus.hideContextMenu();
				}),
			);
			const markerListener = marker.onDispose(() => this.lifetimes.deleteAndDispose(key));
			lifetime.add(toDisposable(() => markerListener.dispose()));
			if (decoration) {
				const item = command;
				const renderedLifetime = lifetime.add(new MutableDisposable<DisposableStore>());
				let renderedElement: HTMLElement | undefined;
				const renderListener = decoration.onRender(element => {
					this.render(element, item);
					if (renderedElement !== element) {
						renderedElement = element;
						const events = new DisposableStore();
						renderedLifetime.value = events;
						events.add(
							getHoverDelegate().setupDelayedHover(element, () => ({
								content: element.getAttribute('aria-label') ?? '',
							})),
						);
						const show = (event: MouseEvent | KeyboardEvent): void => {
							if (!this.commandFor(item)) return;
							event.preventDefault();
							event.stopPropagation();
							this.showCommandMenu(element, item);
						};
						events.add(addDisposableListener(element, 'click', show));
						events.add(addDisposableListener(element, 'contextmenu', show));
						events.add(
							addDisposableListener(element, 'keydown', event => {
								if (
									event.key === 'Enter' ||
									event.key === ' ' ||
									event.key === 'ContextMenu' ||
									(event.key === 'F10' && event.shiftKey)
								)
									show(event);
							}),
						);
					}
				});
				lifetime.add(toDisposable(() => renderListener.dispose()));
				lifetime.add(toDisposable(() => decoration.dispose()));
			}
		} else {
			command.event = event;
			this.updateOverviewRuler(command);
		}
		if (command.decoration?.element) this.render(command.decoration.element, command);
	}

	private commandFor(item: ScreenCommand): ITerminalCommand | undefined {
		if (this.isDisposed || item.marker.isDisposed) return undefined;
		const capability = this.capabilities.get(TerminalCapability.CommandDetection);
		return [...(capability?.commands ?? []), capability?.executingCommandObject].find(
			command => command && command.marker === item.marker && command.id === item.event?.commandId,
		);
	}

	private showCommandMenu(element: HTMLElement, item: ScreenCommand): void {
		const terminal = this.terminal;
		const command = this.commandFor(item);
		if (!terminal || !command) return;
		const current = (): boolean => this.terminal === terminal && this.commandFor(item) === command;
		const action = (id: string, label: string, enabled: boolean, run: () => Promise<void>): IAction => ({
			id,
			label,
			tooltip: label,
			enabled,
			run,
		});
		const output = command.getOutput();
		const hasCommandRange =
			!!command.marker &&
			!command.marker.isDisposed &&
			!!command.executedMarker &&
			!command.executedMarker.isDisposed;
		const actions = [
			action(
				'terminal.copyCommand',
				localize('terminal.command.copy', 'Copy Command'),
				!!command.command,
				async () => {
					if (current()) await this.clipboard.writeText(command.command);
				},
			),
			action(
				'terminal.copyOutput',
				localize('terminal.command.copyOutput', 'Copy Output'),
				output !== undefined,
				async () => {
					const text = current() ? command.getOutput() : undefined;
					if (text !== undefined) await this.clipboard.writeText(text);
				},
			),
			action(
				'terminal.copyCommandAndOutput',
				localize('terminal.command.copyBoth', 'Copy Command and Output'),
				output !== undefined,
				async () => {
					const text = current() ? command.getOutput() : undefined;
					if (text !== undefined) await this.clipboard.writeText(`${command.command}\n${text}`);
				},
			),
			action(
				'terminal.selectCommand',
				localize('terminal.command.select', 'Select Command'),
				hasCommandRange,
				async () => {
					if (
						!current() ||
						command.marker?.isDisposed ||
						command.executedMarker?.isDisposed ||
						terminal.buffer.active.type !== 'normal'
					)
						return;
					const start = command.marker!;
					const end = command.executedMarker!;
					const startX = command.startX ?? 0;
					const length = (end.line - start.line) * terminal.cols + (command.executedX ?? 0) - startX;
					if (length > 0) terminal.select(startX, start.line, length);
				},
			),
			action(
				'terminal.rerunCommand',
				localize('terminal.command.rerun', 'Rerun Command'),
				!!command.command && command.endMarker !== undefined,
				async () => {
					if (current()) this.runCommand.fire({ command });
				},
			),
		];
		let hidden = false;
		this.menus.showContextMenu({
			getAnchor: () => element,
			getActions: () => actions,
			onHide: () => {
				hidden = true;
				if (this.menuCommand === item) this.menuCommand = undefined;
				if (current() && terminal.element?.contains(element.ownerDocument.activeElement)) terminal.focus();
			},
		});
		// Replacing an existing menu synchronously closes it during showContextMenu.
		// Claim this menu only after that callback, unless the new menu was also hidden.
		if (!hidden) this.menuCommand = item;
	}

	private overviewRulerOptions(
		event: ITerminalCommandStatusEvent | undefined,
	): IDecoration['options']['overviewRulerOptions'] {
		const mode = this.configuration.getValue<string>('terminal.integrated.shellIntegration.decorationsEnabled');
		if (mode === 'gutter' || mode === 'never') return undefined;
		const failed = event?.status === 'failed' || event?.status === 'canceled';
		const color = failed
			? TERMINAL_COMMAND_DECORATION_ERROR_BACKGROUND_COLOR
			: event?.status === 'succeeded'
				? TERMINAL_COMMAND_DECORATION_SUCCESS_BACKGROUND_COLOR
				: TERMINAL_COMMAND_DECORATION_DEFAULT_BACKGROUND_COLOR;
		return { color: this.themes.getColorTheme().getColor(color)!.toString(), position: failed ? 'right' : 'left' };
	}

	private updateOverviewRuler(command: ScreenCommand): void {
		if (!command.decoration || !this.terminal) return;
		command.decoration.options.overviewRulerOptions = this.overviewRulerOptions(command.event);
		// xterm redraws the ruler on a viewport refresh, including status changes without output.
		this.terminal.refresh(0, this.terminal.rows - 1);
	}

	private render(element: HTMLElement, item: ScreenCommand): void {
		const event = item.event;
		updateLayout(this.configuration, element);
		const status = event?.status ?? 'pending';
		if (element.dataset.commandStatus !== status) {
			element.classList.remove('pending', 'running', 'completed', 'succeeded', 'failed', 'canceled');
			element.classList.add('ash-terminal-command-status', status);
			element.dataset.commandStatus = status;
			const icon = element.ownerDocument.createElement('span');
			icon.className = 'ash-terminal-command-icon';
			icon.setAttribute('aria-hidden', 'true');
			appendIcon(
				status === 'failed' || status === 'canceled'
					? terminalDecorationError
					: status === 'succeeded'
						? terminalDecorationSuccess
						: terminalDecorationIncomplete,
				icon,
			);
			element.replaceChildren(icon);
		}
		const label = event
			? getTerminalCommandDecorationTooltip(event)
			: localize('terminal.command.pending', 'Waiting for a command');
		const mode = this.configuration.getValue<string>('terminal.integrated.shellIntegration.decorationsEnabled');
		const gutter = mode !== 'overviewRuler' && mode !== 'never';
		// Keep the screen marker for navigation when only its presentation is disabled.
		element.style.visibility = gutter ? '' : 'hidden';
		if (gutter) element.removeAttribute('aria-hidden');
		else element.setAttribute('aria-hidden', 'true');
		const interactive = gutter && !!this.commandFor(item);
		element.setAttribute('role', interactive ? 'button' : 'img');
		element.tabIndex = interactive ? 0 : -1;
		if (interactive) element.setAttribute('aria-haspopup', 'menu');
		else element.removeAttribute('aria-haspopup');
		element.setAttribute('aria-label', label);
		element.title = label;
	}

	protected override disposeCore(): void {
		if (this.menuCommand) this.menus.hideContextMenu();
		this.terminal = undefined;
		this.marks = undefined;
		super.disposeCore();
		this.commands.clear();
	}
}
