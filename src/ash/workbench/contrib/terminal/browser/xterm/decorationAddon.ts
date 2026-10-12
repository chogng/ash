import type { Terminal, ITerminalAddon, IMarker, IDecoration } from '@xterm/xterm';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { ITerminalCommandStatusEvent } from '../../../../services/terminal/browser/terminal.js';
import { getTerminalCommandDecorationTooltip } from './decorationStyles.js';

interface ScreenCommand {
	readonly marker: IMarker;
	readonly decoration: IDecoration | undefined;
	event: ITerminalCommandStatusEvent;
}

/** Owns only screen positions and UI resources, not Shell history or capabilities. */
export class DecorationAddon extends Disposable implements ITerminalAddon {
	private terminal: Terminal | undefined;
	private readonly commands = new Map<string, ScreenCommand>();
	private readonly lifetimes = this._register(new DisposableMap<string, DisposableStore>());
	get markers(): readonly IMarker[] { return [...this.commands.values()].map(command => command.marker); }

	activate(terminal: Terminal): void { this.terminal = terminal; }

	registerCommandDecoration(event: ITerminalCommandStatusEvent, processId: number): void {
		const terminal = this.terminal;
		if (!terminal || this.isDisposed) return;
		const key = `${processId}:${event.commandId}`;
		let command = this.commands.get(key);
		if (!command) {
			const marker = terminal.registerMarker(0);
			if (!marker) return;
			const lifetime = new DisposableStore();
			const decoration = terminal.registerDecoration({ marker, width: 1, layer: 'top' });
			command = { marker, decoration, event };
			this.commands.set(key, command);
			this.lifetimes.set(key, lifetime);
			// Trim/clear must release callbacks immediately, not at screen shutdown.
			lifetime.add(toDisposable(() => this.commands.delete(key)));
			const markerListener = marker.onDispose(() => this.lifetimes.deleteAndDispose(key));
			lifetime.add(toDisposable(() => markerListener.dispose()));
			lifetime.add(toDisposable(() => marker.dispose()));
			if (decoration) {
				const item = command;
				const renderListener = decoration.onRender(element => this.render(element, item.event));
				lifetime.add(toDisposable(() => renderListener.dispose()));
				lifetime.add(toDisposable(() => decoration.dispose()));
			}
		} else {
			command.event = event;
		}
		if (command.decoration?.element) this.render(command.decoration.element, event);
	}

	private render(element: HTMLElement, event: ITerminalCommandStatusEvent): void {
		element.classList.remove('running', 'completed', 'succeeded', 'failed', 'canceled');
		element.classList.add('ash-terminal-command-status', event.status);
		element.dataset.commandStatus = event.status;
		const label = getTerminalCommandDecorationTooltip(event);
		element.setAttribute('role', 'img');
		element.setAttribute('aria-label', label);
		element.title = label;
	}

	protected override disposeCore(): void {
		this.terminal = undefined;
		super.disposeCore();
		this.commands.clear();
	}
}
