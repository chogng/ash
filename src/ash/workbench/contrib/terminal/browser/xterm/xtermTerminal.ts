import { selectionBackground, selectionForeground } from "../../../../../platform/theme/common/colors/baseColors.js";
import type { IColorTheme } from "../../../../../platform/theme/common/themeService.js";
import * as terminalColors from "../../common/terminalColorRegistry.js";

import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon, ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search';
import type { Terminal, IDecoration, ITheme } from "@xterm/xterm";
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { IThemeService } from "../../../../../platform/theme/common/themeService.js";
import { IOpenerService } from "../../../../../platform/opener/common/opener.js";
import { IQuickInputService, type IQuickPickItem } from "../../../../../platform/quickinput/common/quickInput.js";
import { computeLinks } from "../../../../../editor/common/languages/linkComputer.js";
import { onUnexpectedError } from "../../../../../base/common/errors.js";
import { localize } from "../../../../../nls.js";
import type { ITerminalCommandStatusEvent, ITerminalDimensions, ITerminalInstance } from "../terminal.js";
import { h } from "../../../../../base/browser/dom.js";
import { observeResize } from "../../../../../base/browser/observer.js";
import { Emitter } from '../../../../../base/common/event.js';
import { Color } from '../../../../../base/common/color.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { searchMatchBackground } from '../../../../../platform/theme/common/colors/searchColors.js';
import { contrastBorder, focusBorder } from '../../../../../platform/theme/common/colors/baseColors.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';

/** One persistent xterm renderer bound to exactly one Terminal instance. */
export class XtermTerminal extends Disposable {
	readonly element: HTMLDivElement;
	private terminal: Terminal | undefined;
	private fitAddon: FitAddon | undefined;
	private initialization: Promise<void> | undefined;
	private readonly pendingWrites: ((terminal: Terminal) => void)[] = [];
	private focusSource: Element | null | undefined;
	private readonly alternateScroll = new AlternateScrollMode();
	private readonly commandDecorations = new Map<string, TerminalCommandDecoration>();
	private visible = false;
	private readonly linkPicker = this._register(new MutableDisposable<DisposableStore>());
	private searchAddon: SearchAddon | undefined;
	private searchInitialization: Promise<SearchAddon> | undefined;
	private searchGeneration = 0;
	private activeSearch: { term: string; options: ISearchOptions; } | undefined;
	private lastFindResult: ISearchResultChangeEvent | undefined;
	private readonly _onDidChangeFindResults = this._register(new Emitter<ISearchResultChangeEvent>());
	public readonly onDidChangeFindResults = this._onDidChangeFindResults.event;
	public get findResult(): ISearchResultChangeEvent | undefined { return this.lastFindResult; }

	constructor(
		container: HTMLElement,
		readonly instance: ITerminalInstance,
		@IThemeService private readonly themeService: IThemeService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IAccessibilitySignalService private readonly signals: IAccessibilitySignalService,
	) {
		super();
		this.element = h(container.ownerDocument, "div");
		this.element.className = "ash-terminal-instance";
		this.element.hidden = true;
		container.append(this.element);
		this._register(toDisposable(() => {
			this.pendingWrites.length = 0;
			this.element.remove();
		}));
		this._register(instance.onDidWriteData(event => {
			if (event.trackCommit) {
				event.writePromise = new Promise((resolve, reject) => {
					this.writeWhenReady(terminal => terminal.write(event.data, resolve));
					// Existing background Shells must parse without waiting for panel visibility,
					// otherwise Tasks cannot receive completion while the panel is hidden.
					if (!this.terminal) {
						void this.initialize().catch(reject);
					}
				});
			} else {
				this.writeWhenReady(terminal => terminal.write(event.data));
			}
		}));
		this._register(instance.onDidChangeCommandStatus((event) => this.writeWhenReady(terminal => this.renderCommandStatus(terminal, event))));
		this._register(instance.onDidExit((exitCode) => {
			this.writeWhenReady(terminal => {
				terminal.writeln("");
				terminal.writeln(`[process exited with code ${exitCode ?? "unknown"}]`);
			});
		}));
		this._register(instance.onDidChangeState((state) => {
			this.element.dataset.state = state;
			if (state === "error") {
				this.writeWhenReady(terminal => {
					terminal.writeln("");
					terminal.writeln("[terminal operation failed]");
				});
			}
		}));
		this.element.dataset.state = instance.state;
		this._register(observeResize(this.element, () => this.fit()));
	}

	public get raw(): Terminal {
		this.assertNotDisposed();
		if (!this.terminal) { throw new Error('The terminal renderer has not been initialized'); }
		return this.terminal;
	}

	initialize(): Promise<void> {
		this.assertNotDisposed();
		this.initialization ??= this.loadTerminal();
		return this.initialization;
	}

	private async loadTerminal(): Promise<void> {
		const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
			import("@xterm/xterm"),
			import("@xterm/addon-fit"),
			import("@xterm/addon-web-links"),
			import("@xterm/xterm/css/xterm.css"),
		]);
		if (this.isDisposed) return;
		const terminal = new Terminal({
			disableStdin: this.instance.isReadOnly === true,
			allowProposedApi: true,
			allowTransparency: false,
			cursorBlink: true,
			cursorStyle: "block",
			fontFamily: "var(--ash-font-family-monospace, Consolas, 'Courier New', monospace)",
			fontSize: 13,
			scrollback: 5_000,
			theme: terminalTheme(this.themeService.getColorTheme()),
			linkHandler: { activate: (_event, url) => { void this.openLink(url).catch(onUnexpectedError); } },
		});
		this.terminal = terminal;
		this._register(toDisposable(() => terminal.dispose()));
		this.fitAddon = new FitAddon();
		terminal.loadAddon(this.fitAddon);
		terminal.loadAddon(new WebLinksAddon((_event, url) => { void this.openLink(url).catch(onUnexpectedError); }));
		terminal.open(this.element);
		const bell = terminal.onBell(() => { void this.signals.playSignal(AccessibilitySignal.terminalBell); });
		this._register(toDisposable(() => bell.dispose()));
		this.registerAlternateScrollMode(terminal);
		this._register(this.themeService.onDidColorThemeChange(theme => {
			terminal.options.theme = terminalTheme(theme);
			if (this.activeSearch) { void this.findNext(this.activeSearch.term, { ...this.activeSearch.options, incremental: true }).catch(onUnexpectedError); }
		}));
		for (const write of this.pendingWrites) write(terminal);
		this.pendingWrites.length = 0;
		this.fit();
		if (this.visible && this.focusSource !== undefined && this.element.ownerDocument.activeElement === this.focusSource) terminal.focus();
		this.focusSource = undefined;
	}

	private writeWhenReady(write: (terminal: Terminal) => void): void {
		if (this.isDisposed) return;
		if (this.terminal) {
			write(this.terminal);
		} else {
			this.pendingWrites.push(write);
		}
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		if (!visible) this.focusSource = undefined;
		this.element.hidden = !visible;
		if (visible) queueMicrotask(() => this.fit());
	}

	focus(): void {
		if (!this.visible || this.isDisposed) return;
		this.focusSource = this.element.ownerDocument.activeElement;
		this.terminal?.focus();
	}

	clearBuffer(): void {
		this.writeWhenReady(terminal => {
			terminal.clear();
			void this.signals.playSignal(AccessibilitySignal.clear);
		});
	}

	public findNext(term: string, searchOptions: ISearchOptions): Promise<boolean> {
		return this.search(term, searchOptions, false);
	}

	public findPrevious(term: string, searchOptions: ISearchOptions): Promise<boolean> {
		return this.search(term, searchOptions, true);
	}

	public clearSearchDecorations(): void {
		this.searchGeneration++;
		this.activeSearch = undefined;
		this.searchAddon?.clearDecorations();
		this.terminal?.clearSelection();
		this.lastFindResult = { resultIndex: -1, resultCount: 0 };
		this._onDidChangeFindResults.fire(this.lastFindResult);
	}

	private async search(term: string, options: ISearchOptions, previous: boolean): Promise<boolean> {
		const generation = ++this.searchGeneration;
		const addon = await (this.searchInitialization ??= this.loadSearchAddon());
		if (this.isDisposed || generation !== this.searchGeneration) { return false; }
		const previousOptions = this.activeSearch?.options;
		if (previousOptions && (previousOptions.regex !== options.regex || previousOptions.wholeWord !== options.wholeWord || previousOptions.caseSensitive !== options.caseSensitive)) {
			// The addon caches decorated matches by query; option changes need a fresh cache too.
			addon.clearDecorations();
		}
		this.activeSearch = { term, options };
		const theme = this.themeService.getColorTheme();
		const hex = (id: string): string | undefined => {
			const color = theme.getColor(id);
			return color ? Color.Format.CSS.formatHex(color) : undefined;
		};
		const decoratedOptions: ISearchOptions = {
			...options,
			decorations: {
				matchBackground: hex(searchMatchBackground),
				matchBorder: hex(contrastBorder),
				activeMatchBackground: hex(selectionBackground),
				activeMatchBorder: hex(focusBorder),
				matchOverviewRuler: hex(searchMatchBackground)!,
				activeMatchColorOverviewRuler: hex(focusBorder)!,
			},
		};
		return previous ? addon.findPrevious(term, decoratedOptions) : addon.findNext(term, decoratedOptions);
	}

	private async loadSearchAddon(): Promise<SearchAddon> {
		await this.initialize();
		const { SearchAddon } = await import('@xterm/addon-search');
		if (this.isDisposed) { throw new CancellationError(); }
		const addon = new SearchAddon({ highlightLimit: 1000 });
		this.raw.loadAddon(addon);
		this.searchAddon = addon;
		const results = addon.onDidChangeResults(result => {
			this.lastFindResult = result;
			this._onDidChangeFindResults.fire(result);
		});
		// xterm owns addon disposal; this owner releases the Ash event adapter.
		this._register(toDisposable(() => results.dispose()));
		return addon;
	}

	/** Uses xterm's parsed screen, including a selection when present; raw PTY bytes are not a transcript. */
	public async getBufferText(maxCharacters: number, signal: AbortSignal): Promise<string | undefined> {
		if (this.isDisposed || signal.aborted) { return undefined; }
		await this.initialize();
		if (this.isDisposed || signal.aborted) { return undefined; }
		const terminal = this.raw;
		// An empty write completes after queued output. Disposal or cancellation must also release the reader.
		let release: ReturnType<typeof toDisposable> | undefined;
		let abort: (() => void) | undefined;
		try {
			await new Promise<void>(resolve => {
				release = this._register(toDisposable(resolve));
				abort = resolve;
				signal.addEventListener('abort', abort, { once: true });
				terminal.write('', resolve);
			});
		} finally {
			if (abort) { signal.removeEventListener('abort', abort); }
			if (release) {
				this._store.delete(release);
				release.dispose();
			}
		}
		if (this.isDisposed || signal.aborted) { return undefined; }
		let content = terminal.getSelection();
		if (!content) {
			const buffer = terminal.buffer.active;
			const lines: string[] = [];
			let characters = 0;
			for (let index = buffer.length - 1; index >= 0; index--) {
				const line = buffer.getLine(index)!;
				const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
				if (!text && !lines.length) { continue; }
				lines.push(text);
				characters += text.length + (line.isWrapped ? 0 : 1);
				if (!line.isWrapped) { lines.push('\n'); }
				if (characters > maxCharacters + 1) { break; }
			}
			content = lines.reverse().join('').trimEnd().replace(/^\n/, '');
		}
		return content.length > maxCharacters ? `[Earlier output omitted]\n${content.slice(-maxCharacters)}` : content;
	}

	public async openDetectedLink(): Promise<void> {
		await this.initialize();
		this.assertNotDisposed();
		const buffer = this.raw.buffer.active;
		const lines: string[] = [];
		for (let index = 0; index < buffer.length; index++) {
			const line = buffer.getLine(index)!;
			// A wrapped screen row continues the same URL; physical newlines separate links.
			if (line.isWrapped && lines.length > 0) {
				lines[lines.length - 1] += line.translateToString(true);
			} else {
				lines.push(line.translateToString(true));
			}
		}
		const urls = new Set(computeLinks({ getLineCount: () => lines.length, getLineContent: number => lines[number - 1]! }).map(link => String(link.url)).filter(url => /^https?:\/\//iu.test(url)));
		const session = new DisposableStore();
		this.linkPicker.value = session;
		try {
			const url = await new Promise<string | undefined>(resolve => {
				session.add(toDisposable(() => resolve(undefined)));
				const picker = session.add(this.quickInputService.createQuickPick<IQuickPickItem>());
				picker.ariaLabel = localize('terminal.links.choose', 'Open a terminal link');
				picker.placeholder = localize('terminal.links.select', 'Select a terminal URL to open');
				picker.items = Array.from(urls, label => ({ label }));
				session.add(picker.onDidAccept(item => resolve(item.label)));
				session.add(picker.onDidHide(() => resolve(undefined)));
				session.add(picker.onDidBlur(() => resolve(undefined)));
				picker.show();
			});
			// Close Quick Input before opening an editor so its focus restoration cannot steal focus.
			session.dispose();
			if (url) { await this.openLink(url); }
			else { this.focus(); }
		} finally {
			session.dispose();
		}
	}

	private async openLink(url: string): Promise<void> {
		await this.openerService.open(url, { openExternal: true, fromUserGesture: true, allowContributedOpeners: true });
	}

	fit(): void {
		if (!this.visible || !this.fitAddon || this.isDisposed) return;
		if (this.element.clientWidth <= 0 || this.element.clientHeight <= 0) return;
		try {
			this.fitAddon.fit();
		} catch {
			return;
		}
		this.instance.resize(this.dimensions());
	}

	dimensions(): ITerminalDimensions {
		return {
			rows: Math.min(512, Math.max(1, this.terminal?.rows ?? 24)),
			cols: Math.min(512, Math.max(1, this.terminal?.cols ?? 80)),
		};
	}

	private registerAlternateScrollMode(terminal: Terminal): void {
		const registerMode = (final: string, update: (parameters: (number | number[])[]) => void): void => {
			const registration = terminal.parser.registerCsiHandler({ prefix: '?', final }, parameters => {
				update(parameters);
				return false;
			});
			this._register(toDisposable(() => registration.dispose()));
		};
		registerMode("h", parameters => this.alternateScroll.set(parameters, true));
		registerMode("l", parameters => this.alternateScroll.set(parameters, false));
		registerMode("s", parameters => this.alternateScroll.save(parameters));
		registerMode("r", parameters => this.alternateScroll.restore(parameters));
		terminal.attachCustomWheelEventHandler(() => this.alternateScroll.shouldProcessWheel(
			terminal.buffer.active.type,
			terminal.modes.mouseTrackingMode,
		));
	}

	private renderCommandStatus(terminal: Terminal, event: ITerminalCommandStatusEvent): void {
		let item = this.commandDecorations.get(event.commandId);
		if (!item) {
			const marker = terminal.registerMarker(0);
			const decoration = terminal.registerDecoration({ marker, width: 1, layer: "top" });
			if (!decoration) return;
			item = { event, decoration };
			this.commandDecorations.set(event.commandId, item);
			const renderListener = decoration.onRender((element) => this.presentCommandStatus(element, item!));
			const disposeListener = decoration.onDispose(() => this.commandDecorations.delete(event.commandId));
			this._register(toDisposable(() => renderListener.dispose()));
			this._register(toDisposable(() => disposeListener.dispose()));
			this._register(toDisposable(() => decoration.dispose()));
		} else {
			item.event = event;
		}
		if (item.decoration.element) this.presentCommandStatus(item.decoration.element, item);
	}

	private presentCommandStatus(element: HTMLElement, item: TerminalCommandDecoration): void {
		const { status, exitCode } = item.event;
		element.classList.remove("running", "completed", "succeeded", "failed", "canceled");
		element.classList.add("ash-terminal-command-status", status);
		element.dataset.commandStatus = status;
		const label = terminalCommandStatusLabel(status, exitCode);
		element.setAttribute("role", "img");
		element.setAttribute("aria-label", label);
		element.title = label;
	}
}

interface TerminalCommandDecoration {
	event: ITerminalCommandStatusEvent;
	readonly decoration: IDecoration;
}

function terminalCommandStatusLabel(status: ITerminalCommandStatusEvent["status"], exitCode: number | undefined): string {
	switch (status) {
		case "running": return "Command is running";
		case "completed": return "Command completed; exit code unavailable";
		case "succeeded": return "Command completed successfully";
		case "failed": return exitCode === undefined ? "Command failed" : `Command failed with exit code ${exitCode}`;
		case "canceled": return "Command was canceled";
	}
}

/** Projects the workbench theme into xterm's renderer theme contract. */
export function terminalTheme(theme: IColorTheme): ITheme {
	return {
		background: theme.getColorCss(terminalColors.terminalBackground),
		foreground: theme.getColorCss(terminalColors.terminalForeground),
		cursor: theme.getColorCss(terminalColors.terminalCursorForeground),
		selectionForeground: theme.getColorCss(selectionForeground),
		selectionBackground: theme.getColorCss(selectionBackground),
		black: theme.getColorCss(terminalColors.terminalAnsiBlack),
		red: theme.getColorCss(terminalColors.terminalAnsiRed),
		green: theme.getColorCss(terminalColors.terminalAnsiGreen),
		yellow: theme.getColorCss(terminalColors.terminalAnsiYellow),
		blue: theme.getColorCss(terminalColors.terminalAnsiBlue),
		magenta: theme.getColorCss(terminalColors.terminalAnsiMagenta),
		cyan: theme.getColorCss(terminalColors.terminalAnsiCyan),
		white: theme.getColorCss(terminalColors.terminalAnsiWhite),
		brightBlack: theme.getColorCss(terminalColors.terminalAnsiBrightBlack),
		brightRed: theme.getColorCss(terminalColors.terminalAnsiBrightRed),
		brightGreen: theme.getColorCss(terminalColors.terminalAnsiBrightGreen),
		brightYellow: theme.getColorCss(terminalColors.terminalAnsiBrightYellow),
		brightBlue: theme.getColorCss(terminalColors.terminalAnsiBrightBlue),
		brightMagenta: theme.getColorCss(terminalColors.terminalAnsiBrightMagenta),
		brightCyan: theme.getColorCss(terminalColors.terminalAnsiBrightCyan),
		brightWhite: theme.getColorCss(terminalColors.terminalAnsiBrightWhite),
	};
}

const ALTERNATE_SCROLL_MODE = 1007;

type TerminalScreen = 'normal' | 'alternate';
type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';
type TerminalParameters = ArrayLike<number | readonly number[]>;

/** Tracks xterm alternate-scroll control sequences that xterm.js does not expose as a mode. */
export class AlternateScrollMode {
	private enabled = true;
	private saved: boolean | undefined;

	public set(parameters: TerminalParameters, enabled: boolean): void {
		if (hasAlternateScroll(parameters)) {
			this.enabled = enabled;
		}
	}

	public save(parameters: TerminalParameters): void {
		if (hasAlternateScroll(parameters)) {
			this.saved = this.enabled;
		}
	}

	public restore(parameters: TerminalParameters): void {
		if (hasAlternateScroll(parameters) && this.saved !== undefined) {
			this.enabled = this.saved;
			this.saved = undefined;
		}
	}

	public shouldProcessWheel(screen: TerminalScreen, mouseTracking: MouseTrackingMode): boolean {
		return screen !== 'alternate' || mouseTracking !== 'none' || this.enabled;
	}
}

function hasAlternateScroll(parameters: TerminalParameters): boolean {
	for (let index = 0; index < parameters.length; index++) {
		if (parameters[index] === ALTERNATE_SCROLL_MODE) {
			return true;
		}
	}
	return false;
}
