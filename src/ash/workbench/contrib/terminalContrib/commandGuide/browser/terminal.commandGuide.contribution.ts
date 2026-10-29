import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { observeResize } from '../../../../../base/browser/observer.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { isFullTerminalCommand } from '../../../../../platform/terminal/common/capabilities/commandDetection/terminalCommand.js';
import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';
import { contrastBorder } from '../../../../../platform/theme/common/colors/baseColors.js';
import { listInactiveSelectionBackground } from '../../../../../platform/theme/common/colors/listColors.js';
import type { ITerminalContribution, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalCommandGuideSettingId } from '../common/terminalCommandGuideConfiguration.js';
import './media/terminalCommandGuide.css';

export const TERMINAL_COMMAND_GUIDE_COLOR = registerColor('terminalCommandGuide.foreground', {
	dark: listInactiveSelectionBackground,
	light: listInactiveSelectionBackground,
	hcDark: contrastBorder,
	hcLight: contrastBorder,
}, {
	owner: 'workbench.terminal.commandGuide',
	description: localize('terminal.commandGuide.foreground', 'Color of the guide beside the hovered terminal command and its output.'),
});

/** Pointer and geometry are local; command ranges remain owned by detection markers. */
class TerminalCommandGuideContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.commandGuide';
	readonly id = TerminalCommandGuideContribution.ID;
	private readonly capabilityListeners = this._register(new DisposableStore());
	private screen: IXtermTerminal | undefined;
	private guide: HTMLDivElement | undefined;
	private pointer: { x: number; y: number; } | undefined;

	constructor(
		private readonly context: ITerminalContributionContext,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this._register(context.instance.onDidChangeState(() => this.clear()));
		this._register(context.instance.onDidExit(() => this.clear()));
	}

	xtermReady(screen: IXtermTerminal): void {
		this.screen = screen;
		const guide = this.guide = screen.element.ownerDocument.createElement('div');
		guide.className = 'ash-terminal-command-guide';
		guide.setAttribute('aria-hidden', 'true');
		guide.hidden = true;
		this._register(toDisposable(() => guide.remove()));
		const attachment = screen.attachWidget(this);
		if (attachment) this._register(attachment);
		this._register(addDisposableListener(screen.element, 'mousemove', (event: MouseEvent) => {
			if ((event.target as Element | null)?.closest('.ash-terminal-widget-overlay')) {
				this.clear();
				return;
			}
			this.pointer = { x: event.clientX, y: event.clientY };
			this.render();
		}));
		this._register(addDisposableListener(screen.element, 'mouseleave', () => this.clear()));
		for (const listener of [
			screen.raw.onData(() => this.clear()),
			screen.raw.onRender(() => this.render()),
			screen.raw.onScroll(() => this.render()),
			screen.raw.onResize(() => this.render()),
			screen.raw.buffer.onBufferChange(() => this.clear()),
		]) this._register(toDisposable(() => listener.dispose()));
		this._register(observeResize(screen.element, () => this.render()));
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(TerminalCommandGuideSettingId.ShowCommandGuide)) this.clear();
		}));
		if (this.context.instance.capabilities) {
			this._register(this.context.instance.capabilities.onDidChangeCapabilities(() => this.bindCapability()));
		}
		this.bindCapability();
	}

	attach(container: HTMLElement): void { if (this.guide) container.append(this.guide); }

	private bindCapability(): void {
		this.capabilityListeners.clear();
		this.clear();
		const capability = this.context.instance.capabilities?.get(TerminalCapability.CommandDetection);
		if (!capability) return;
		for (const event of [capability.onCommandStarted, capability.onCommandExecuted, capability.onCommandFinished, capability.onCommandInvalidated, capability.onCurrentCommandInvalidated]) {
			this.capabilityListeners.add(event(() => this.render()));
		}
	}

	private clear(): void {
		this.pointer = undefined;
		if (this.guide) this.guide.hidden = true;
	}

	private render(): void {
		const screen = this.screen;
		const guide = this.guide;
		if (!screen || screen.isDisposed || !guide) return;
		guide.hidden = true;
		if (!this.pointer || !this.configuration.getValue<boolean>(TerminalCommandGuideSettingId.ShowCommandGuide)
			|| !screen.element.isConnected || screen.element.hidden || screen.raw.buffer.active.type !== 'normal') return;
		const bounds = screen.element.querySelector('.xterm-screen')?.getBoundingClientRect();
		if (!bounds?.height || this.pointer.x < bounds.left || this.pointer.x >= bounds.right
			|| this.pointer.y < bounds.top || this.pointer.y >= bounds.bottom) return;
		const raw = screen.raw;
		const buffer = raw.buffer.active;
		const rowHeight = bounds.height / raw.rows;
		const line = buffer.viewportY + Math.floor((this.pointer.y - bounds.top) / rowHeight);
		const command = this.context.instance.capabilities?.get(TerminalCapability.CommandDetection)?.getCommandForLine(line);
		if (!command || !isFullTerminalCommand(command)) return;
		const start = command.promptStartMarker ?? command.marker;
		const end = command.endMarker;
		if (!start || start.isDisposed || !end || end.isDisposed || end.line <= start.line) return;
		const firstRow = Math.max(start.line - buffer.viewportY, 0);
		const lastRow = Math.min(end.line - buffer.viewportY, raw.rows);
		if (lastRow <= firstRow) return;
		const parent = guide.parentElement?.getBoundingClientRect();
		if (!parent) return;
		guide.style.left = `${bounds.left - parent.left}px`;
		guide.style.top = `${bounds.top - parent.top + firstRow * rowHeight}px`;
		guide.style.height = `${(lastRow - firstRow) * rowHeight}px`;
		guide.hidden = false;
	}
}

registerTerminalContribution(TerminalCommandGuideContribution.ID, TerminalCommandGuideContribution);
