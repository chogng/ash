import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { observeResize } from '../../../../../base/browser/observer.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IHoverService } from '../../../../../platform/hover/browser/hoverService.js';
import { TerminalCapability, type ICommandDetectionCapability, type IMarkProperties } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { isFullTerminalCommand } from '../../../../../platform/terminal/common/capabilities/commandDetection/terminalCommand.js';
import type { ITerminalInstance, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import { TerminalStickyScrollSettingId } from '../common/terminalStickyScrollConfiguration.js';
import './media/stickyScroll.css';

/** A projection of retained screen cells. Command detection and xterm retain all command state. */
export class TerminalStickyScrollOverlay extends Disposable {
	public readonly id = 'stickyScroll';
	private readonly button: HTMLButtonElement;
	private readonly commandListeners = this._register(new DisposableStore());
	private capability: ICommandDetectionCapability | undefined;
	private target: IMarkProperties['marker'];

	constructor(
		private readonly instance: ITerminalInstance,
		private readonly xterm: IXtermTerminal,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IHoverService hover: IHoverService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super();
		this.button = xterm.element.ownerDocument.createElement('button');
		this.button.type = 'button';
		this.button.className = 'ash-terminal-sticky-scroll';
		this.button.hidden = true;
		const scope = this._register(contextKeys.createScoped(this.button));
		TerminalContextKeys.focus.bindTo(scope).set(true);
		const updateHint = (): void => {
			const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Terminal);
			if (hint) this.button.setAttribute('aria-description', hint);
			else this.button.removeAttribute('aria-description');
		};
		updateHint();
		this._register(toDisposable(() => this.button.remove()));
		const attachment = xterm.attachWidget(this);
		if (attachment) this._register(attachment);
		this._register(hover.setupDelayedHover(this.button, () => ({ content: this.button.getAttribute('aria-label') ?? '' })));
		this._register(addDisposableListener(this.button, 'click', () => {
			const marker = this.target;
			if (marker && !marker.isDisposed) xterm.raw.scrollToLine(marker.line);
			xterm.focus();
		}));
		this._register(addDisposableListener(this.button, 'keydown', event => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			xterm.focus();
		}));
		// The header covers part of xterm's scrollable surface, so keep wheel navigation working there.
		this._register(addDisposableListener(this.button, 'wheel', event => {
			event.preventDefault();
			const delta = event.deltaMode === 1 ? event.deltaY : event.deltaMode === 2 ? event.deltaY * xterm.raw.rows : event.deltaY / this.rowHeight();
			xterm.raw.scrollLines(Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta))));
		}, { passive: false }));
		for (const listener of [
			xterm.raw.onScroll(() => this.render()),
			xterm.raw.onRender(() => this.render()),
			xterm.raw.onResize(() => this.render()),
			xterm.raw.buffer.onBufferChange(() => this.render()),
		]) this._register(toDisposable(() => listener.dispose()));
		this._register(observeResize(xterm.element, () => this.render()));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('terminal.integrated.stickyScroll')) this.render();
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.Terminal)) updateHint();
		}));
		if (instance.capabilities) this._register(instance.capabilities.onDidChangeCapabilities(() => this.bindCapability()));
		this.bindCapability();
	}

	public attach(container: HTMLElement): void { container.append(this.button); }

	private bindCapability(): void {
		const capability = this.instance.capabilities?.get(TerminalCapability.CommandDetection);
		if (capability !== this.capability) {
			this.commandListeners.clear();
			this.capability = capability;
			if (capability) {
				for (const event of [capability.onCommandStarted, capability.onCommandExecuted, capability.onCommandFinished, capability.onCommandInvalidated, capability.onCurrentCommandInvalidated, capability.onSetRichCommandDetection]) {
					this.commandListeners.add(event(() => this.render()));
				}
			}
		}
		this.render();
	}

	private rowHeight(): number {
		return (this.xterm.element.querySelector('.xterm-screen')?.getBoundingClientRect().height ?? 0) / this.xterm.raw.rows || 1;
	}

	private render(): void {
		if (this.renderHeader()) return;
		if (this.button.ownerDocument.activeElement === this.button) this.xterm.focus();
		this.button.hidden = true;
		this.target = undefined;
	}

	private renderHeader(): boolean {
		const raw = this.xterm.raw;
		const capability = this.capability;
		const buffer = raw.buffer.active;
		if (!this.configuration.getValue<boolean>(TerminalStickyScrollSettingId.Enabled) || !capability?.hasRichCommandDetection || buffer.type !== 'normal') return false;
		const command = capability.getCommandForLine(buffer.viewportY);
		if (!command) return false;
		const full = isFullTerminalCommand(command);
		const start = command.promptStartMarker ?? (full ? command.marker : command.commandStartMarker);
		const executed = full ? command.executedMarker : command.commandExecutedMarker;
		if (!start || start.isDisposed || !executed || executed.isDisposed || buffer.viewportY <= start.line) return false;
		const name = command.command?.trim().split(/\s+/, 1)[0]?.toLowerCase();
		if (this.configuration.getValue<string[]>(TerminalStickyScrollSettingId.IgnoredCommands).some(ignored => ignored.toLowerCase() === name)) return false;
		const end = executed.line - ((full ? command.executedX : command.commandExecutedX) === 0 ? 1 : 0);
		const limit = Math.min(this.configuration.getValue<number>(TerminalStickyScrollSettingId.MaxLineCount), Math.floor(raw.rows * 0.4));
		const count = Math.min(end - start.line + 1, limit);
		const screen = this.xterm.element.querySelector('.xterm-screen');
		if (count <= 0 || !screen) return false;
		const text: string[] = [];
		for (let line = end - count + 1; line <= end; line++) {
			const cells = buffer.getLine(line);
			if (!cells) return false;
			text.push(cells.translateToString(true));
		}
		const content = text.join('\n');
		if (Array.from(this.button.children, row => row.textContent).join('\n') !== content) {
			this.button.replaceChildren(...text.map(value => {
				const row = this.button.ownerDocument.createElement('span');
				row.textContent = value;
				return row;
			}));
		}
		const bounds = screen.getBoundingClientRect();
		const parent = this.button.parentElement!.getBoundingClientRect();
		const rowHeight = this.rowHeight();
		this.button.style.left = `${bounds.left - parent.left}px`;
		this.button.style.top = `${bounds.top - parent.top}px`;
		this.button.style.width = `${bounds.width}px`;
		this.button.style.height = `${count * rowHeight}px`;
		this.button.style.fontFamily = raw.options.fontFamily ?? 'monospace';
		this.button.style.fontSize = `${raw.options.fontSize}px`;
		this.button.style.letterSpacing = `${raw.options.letterSpacing ?? 0}px`;
		this.button.style.lineHeight = `${rowHeight}px`;
		this.button.setAttribute('aria-label', localize('terminal.stickyScroll.scrollToCommand', 'Scroll to command: {0}', command.command || content));
		this.target = start;
		this.button.hidden = false;
		return true;
	}
}
