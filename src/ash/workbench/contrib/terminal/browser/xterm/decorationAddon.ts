import type { Terminal, ITerminalAddon, IMarker, IDecoration } from '@xterm/xterm';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { TerminalCapability, type IBufferMarkCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalCapabilityStore } from '../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import type { ITerminalCommandStatusEvent } from '../../../../services/terminal/browser/terminal.js';
import { getTerminalCommandDecorationTooltip, updateLayout } from './decorationStyles.js';
import { terminalDecorationIncomplete, terminalDecorationSuccess, terminalDecorationError } from '../terminalIcons.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { localize } from '../../../../../nls.js';
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
	get markers(): readonly IMarker[] { return [...this.marks?.markers() ?? []]; }

	constructor(
		private readonly capabilities: TerminalCapabilityStore,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService private readonly themes: IThemeService,
	) {
		super();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration('terminal.integrated.fontSize') && !event.affectsConfiguration('terminal.integrated.lineHeight')) return;
			for (const command of this.commands.values()) {
				if (command.decoration?.element) updateLayout(configuration, command.decoration.element);
			}
		}));
		this._register(themes.onDidColorThemeChange(() => {
			for (const command of this.commands.values()) this.updateOverviewRuler(command);
		}));
	}

	activate(terminal: Terminal): void {
		this.lifetimes.clearAndDisposeAll();
		this.marks = this.capabilities.get(TerminalCapability.BufferMarkDetection);
		this.terminal = terminal;
	}

	registerCommandDecoration(event: ITerminalCommandStatusEvent | undefined, processId: number, suppliedMarker: IMarker): void {
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
			const decoration = terminal.registerDecoration({ marker, width: 1, layer: 'top', overviewRulerOptions: this.overviewRulerOptions(event) });
			command = { marker, decoration, event };
			this.commands.set(key, command);
			this.lifetimes.set(key, lifetime);
			// Trim/clear must release callbacks immediately, not at screen shutdown.
			lifetime.add(toDisposable(() => this.commands.delete(key)));
			const markerListener = marker.onDispose(() => this.lifetimes.deleteAndDispose(key));
			lifetime.add(toDisposable(() => markerListener.dispose()));
			if (decoration) {
				const item = command;
				const hoverTargets = new WeakSet<HTMLElement>();
				const renderListener = decoration.onRender(element => {
					this.render(element, item.event);
					if (!hoverTargets.has(element)) {
						hoverTargets.add(element);
						lifetime.add(getHoverDelegate().setupDelayedHover(element, () => ({ content: element.getAttribute('aria-label') ?? '' })));
					}
				});
				lifetime.add(toDisposable(() => renderListener.dispose()));
				lifetime.add(toDisposable(() => decoration.dispose()));
			}
		} else {
			command.event = event;
			this.updateOverviewRuler(command);
		}
		if (command.decoration?.element) this.render(command.decoration.element, event);
	}

	private overviewRulerOptions(event: ITerminalCommandStatusEvent | undefined): NonNullable<IDecoration['options']['overviewRulerOptions']> {
		const failed = event?.status === 'failed' || event?.status === 'canceled';
		const color = failed ? TERMINAL_COMMAND_DECORATION_ERROR_BACKGROUND_COLOR
			: event?.status === 'succeeded' ? TERMINAL_COMMAND_DECORATION_SUCCESS_BACKGROUND_COLOR
				: TERMINAL_COMMAND_DECORATION_DEFAULT_BACKGROUND_COLOR;
		return { color: this.themes.getColorTheme().getColor(color)!.toString(), position: failed ? 'right' : 'left' };
	}

	private updateOverviewRuler(command: ScreenCommand): void {
		if (!command.decoration || !this.terminal) return;
		command.decoration.options.overviewRulerOptions = this.overviewRulerOptions(command.event);
		// xterm redraws the ruler on a viewport refresh, including status changes without output.
		this.terminal.refresh(0, this.terminal.rows - 1);
	}

	private render(element: HTMLElement, event: ITerminalCommandStatusEvent | undefined): void {
		updateLayout(this.configuration, element);
		const status = event?.status ?? 'pending';
		if (element.dataset.commandStatus !== status) {
			element.classList.remove('pending', 'running', 'completed', 'succeeded', 'failed', 'canceled');
			element.classList.add('ash-terminal-command-status', status);
			element.dataset.commandStatus = status;
			const icon = element.ownerDocument.createElement('span');
			icon.className = 'ash-terminal-command-icon';
			appendIcon(status === 'failed' || status === 'canceled' ? terminalDecorationError : status === 'succeeded' ? terminalDecorationSuccess : terminalDecorationIncomplete, icon);
			element.replaceChildren(icon);
		}
		const label = event ? getTerminalCommandDecorationTooltip(event) : localize('terminal.command.pending', 'Waiting for a command');
		element.setAttribute('role', 'img');
		element.setAttribute('aria-label', label);
	}

	protected override disposeCore(): void {
		this.terminal = undefined;
		this.marks = undefined;
		super.disposeCore();
		this.commands.clear();
	}
}
