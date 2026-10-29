import type { IBufferCell } from '@xterm/xterm';
import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { observeResize } from '../../../../../base/browser/observer.js';
import { Color } from '../../../../../base/common/color.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IHoverService, type IManagedHover } from '../../../../../platform/hover/browser/hoverService.js';
import { TerminalCapability, type ICommandDetectionCapability, type IMarkProperties } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { isFullTerminalCommand } from '../../../../../platform/terminal/common/capabilities/commandDetection/terminalCommand.js';
import type { ITerminalInstance, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import { TerminalStickyScrollSettingId } from '../common/terminalStickyScrollConfiguration.js';
import './media/stickyScroll.css';

const ansiColors = [
	'black',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white',
	'brightBlack',
	'brightRed',
	'brightGreen',
	'brightYellow',
	'brightBlue',
	'brightMagenta',
	'brightCyan',
	'brightWhite',
] as const;

interface ICellRun {
	text: string;
	width: number;
	readonly style: string;
}

/** A projection of retained screen cells. Command detection and xterm retain all command state. */
export class TerminalStickyScrollOverlay extends Disposable {
	public readonly id = 'stickyScroll';
	private readonly button: HTMLButtonElement;
	private readonly headerHover: IManagedHover;
	private readonly commandListeners = this._register(new DisposableStore());
	private capability: ICommandDetectionCapability | undefined;
	private target: IMarkProperties['marker'];
	private renderedContent = '';

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
		this.headerHover = this._register(hover.setupHover({
			target: this.button,
			content: () => this.button.getAttribute('aria-label') ?? '',
			setupKeyboardEvents: false,
		}));
		this._register(addDisposableListener(this.button, 'click', () => {
			const marker = this.target;
			if (marker && !marker.isDisposed) xterm.raw.scrollToLine(marker.line);
			xterm.focus();
		}));
		// Handle the focused header before an open hover's window-level Escape listener.
		this._register(addDisposableListener(this.button.ownerDocument.defaultView!, 'keydown', event => {
			if (event.key !== 'Escape' || this.button.ownerDocument.activeElement !== this.button) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			this.headerHover.hide();
			xterm.focus();
		}, true));
		// Reuse xterm's viewport so fractional trackpad deltas, sensitivity and mouse protocols
		// follow the same path as the uncovered screen instead of rounding each packet to a row.
		this._register(addDisposableListener(this.button, 'wheel', event => {
			const screen = xterm.element.querySelector('.xterm-screen');
			const window = this.button.ownerDocument.defaultView;
			if (!screen || !window) return;
			event.preventDefault();
			event.stopPropagation();
			screen.dispatchEvent(new window.WheelEvent(event.type, event));
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
		this.headerHover.hide();
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
		// Prompt markers, including an unexecuted multi-line prompt, are the boundary.
		// A command's end marker can precede that prompt and would hide the header early.
		let visibleRows = count;
		for (const candidate of [...capability.commands, capability.currentCommand]) {
			if (!candidate) continue;
			const marker = candidate.promptStartMarker ?? (isFullTerminalCommand(candidate) ? candidate.marker : candidate.commandStartMarker);
			if (marker && !marker.isDisposed && marker.line > start.line) {
				visibleRows = Math.min(visibleRows, marker.line - buffer.viewportY);
			}
		}
		if (visibleRows <= 0) return false;
		const bounds = screen.getBoundingClientRect();
		const parent = this.button.parentElement!.getBoundingClientRect();
		const rowHeight = this.rowHeight();
		const firstLine = end - count + 1;
		if (!this.renderRows(firstLine, end, bounds.width / raw.cols)) return false;
		const hiddenHeight = (count - visibleRows) * rowHeight;
		this.button.style.left = `${bounds.left - parent.left}px`;
		this.button.style.top = `${bounds.top - parent.top - hiddenHeight}px`;
		this.button.style.clipPath = `inset(${hiddenHeight}px 0 0 0)`;
		this.button.style.width = `${bounds.width}px`;
		this.button.style.height = `${count * rowHeight}px`;
		this.button.style.fontFamily = raw.options.fontFamily ?? 'monospace';
		this.button.style.fontSize = `${raw.options.fontSize}px`;
		this.button.style.fontWeight = `${raw.options.fontWeight ?? 'normal'}`;
		this.button.style.letterSpacing = `${raw.options.letterSpacing ?? 0}px`;
		this.button.style.lineHeight = `${rowHeight}px`;
		this.button.classList.toggle('truncated', firstLine > start.line);
		const content = Array.from(this.button.children, row => row.textContent?.trimEnd()).join('\n');
		this.button.setAttribute('aria-label', localize('terminal.stickyScroll.scrollToCommand', 'Scroll to command: {0}', command.command || content));
		this.target = start;
		this.button.hidden = false;
		return true;
	}

	private renderRows(firstLine: number, lastLine: number, cellWidth: number): boolean {
		const raw = this.xterm.raw;
		const buffer = raw.buffer.active;
		const cell = buffer.getNullCell();
		const rows: ICellRun[][] = [];
		const styles = new Map<string, string>();
		for (let line = firstLine; line <= lastLine; line++) {
			const cells = buffer.getLine(line);
			if (!cells) return false;
			let length = Math.min(cells.length, raw.cols);
			while (length > 0) {
				cells.getCell(length - 1, cell);
				if (cell.getChars() || !cell.isBgDefault() || cell.isInverse()) break;
				length--;
			}
			const runs: ICellRun[] = [];
			for (let column = 0; column < length; column++) {
				cells.getCell(column, cell);
				const width = cell.getWidth();
				if (!width) continue;
				const text = cell.getChars() || ' ';
				const code = cell.getCode();
				// Powerline separators and box/block glyphs carry background colors, not text contrast.
				const adjustContrast = !(code >= 0x2500 && code <= 0x259f || code >= 0xe0a4 && code <= 0xe0d6);
				const attributes = [
					cell.getFgColorMode(),
					cell.getFgColor(),
					cell.getBgColorMode(),
					cell.getBgColor(),
					cell.isBold(),
					cell.isItalic(),
					cell.isDim(),
					cell.isUnderline(),
					cell.isStrikethrough(),
					cell.isOverline(),
					cell.isInverse(),
					cell.isInvisible(),
					adjustContrast,
				].join(',');
				let style = styles.get(attributes);
				if (style === undefined) {
					style = this.cellStyle(cell, { adjustContrast });
					styles.set(attributes, style);
				}
				const previous = runs.at(-1);
				if (previous?.style === style) {
					previous.text += text;
					previous.width += width;
				} else {
					runs.push({ text, width, style });
				}
			}
			rows.push(runs);
		}
		// Only cache this DOM projection; the original buffer remains the source of truth.
		const content = JSON.stringify({ rows, cellWidth });
		if (content === this.renderedContent) return true;
		this.renderedContent = content;
		const document = this.button.ownerDocument;
		this.button.replaceChildren(...rows.map(runs => {
			const row = document.createElement('span');
			for (const run of runs) {
				const span = document.createElement('span');
				span.textContent = run.text;
				span.style.cssText = run.style;
				span.style.width = `${run.width * cellWidth}px`;
				row.append(span);
			}
			return row;
		}));
		return true;
	}

	private cellStyle(cell: IBufferCell, options: { adjustContrast: boolean; }): string {
		let foreground = this.cellColor(cell, 'foreground');
		const background = this.cellColor(cell, 'background');
		// Match the original DOM renderer's contrast input for default inverted text.
		const contrastForeground = cell.isInverse() && cell.isBgDefault() ? this.xterm.raw.options.theme?.foreground ?? foreground : foreground;
		const foregroundColor = Color.Format.CSS.parse(contrastForeground);
		const backgroundColor = Color.Format.CSS.parse(background);
		if (options.adjustContrast && foregroundColor && backgroundColor) {
			const ratio = (this.xterm.raw.options.minimumContrastRatio ?? 1) / (cell.isDim() ? 2 : 1);
			if (backgroundColor.getContrastRatio(foregroundColor) < ratio) foreground = backgroundColor.ensureConstrast(foregroundColor, ratio).toString();
		}
		const decorations = [
			cell.isUnderline() ? 'underline' : '',
			cell.isStrikethrough() ? 'line-through' : '',
			cell.isOverline() ? 'overline' : '',
		].filter(Boolean).join(' ') || 'none';
		return [
			`color: ${foreground}`,
			`background-color: ${background}`,
			`font-weight: ${cell.isBold() ? this.xterm.raw.options.fontWeightBold : this.xterm.raw.options.fontWeight}`,
			`font-style: ${cell.isItalic() ? 'italic' : 'normal'}`,
			`text-decoration-line: ${decorations}`,
			`opacity: ${cell.isDim() ? 0.5 : 1}`,
			`visibility: ${cell.isInvisible() ? 'hidden' : 'visible'}`,
		].join(';');
	}

	private cellColor(cell: IBufferCell, layer: 'foreground' | 'background'): string {
		const foreground = layer === 'foreground';
		const sourceForeground = cell.isInverse() ? !foreground : foreground;
		let color = sourceForeground ? cell.getFgColor() : cell.getBgColor();
		if (sourceForeground ? cell.isFgRGB() : cell.isBgRGB()) return `#${color.toString(16).padStart(6, '0')}`;
		if (!(sourceForeground ? cell.isFgPalette() : cell.isBgPalette())) {
			return sourceForeground ? this.xterm.raw.options.theme?.foreground ?? 'var(--ash-terminal-foreground)' : this.xterm.raw.options.theme?.background ?? 'var(--ash-terminal-surface-background)';
		}
		if (foreground && color < 8 && cell.isBold() && this.xterm.raw.options.drawBoldTextInBrightColors) color += 8;
		const name = ansiColors[color];
		if (name) return this.xterm.raw.options.theme?.[name] ?? `var(--ash-terminal-ansi${name[0]!.toUpperCase()}${name.slice(1)})`;
		// Extended ANSI colors are terminal content, independent of workbench chrome colors.
		if (color >= 232) {
			const gray = 8 + (color - 232) * 10;
			return `rgb(${gray}, ${gray}, ${gray})`;
		}
		const index = color - 16;
		const channel = (level: number): number => level === 0 ? 0 : level * 40 + 55;
		return `rgb(${channel(Math.floor(index / 36))}, ${channel(Math.floor(index / 6) % 6)}, ${channel(index % 6)})`;
	}
}
