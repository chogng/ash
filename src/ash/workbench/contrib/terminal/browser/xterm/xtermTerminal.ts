import type { IXtermCore } from '../xterm-private.js';
import { LineDataEventAddon } from './lineDataEventAddon.js';
import { DecorationAddon } from './decorationAddon.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { ShellIntegrationAddon } from '../../../../../platform/terminal/common/xterm/shellIntegrationAddon.js';
import type { TerminalShellIntegrationEvent } from '../../../../../platform/terminal/common/terminal.js';
import { TerminalCapabilityStore } from '../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import { MarkNavigationAddon } from './markNavigationAddon.js';
import '../media/xterm.css';
import { selectionBackground, selectionForeground } from "../../../../../platform/theme/common/colors/baseColors.js";
import type { IColorTheme } from "../../../../../platform/theme/common/themeService.js";
import * as terminalColors from "../../common/terminalColorRegistry.js";

import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon, ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search';
import type { Terminal, ITheme, ITerminalOptions } from "@xterm/xterm";
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { IThemeService } from "../../../../../platform/theme/common/themeService.js";
import { IOpenerService } from "../../../../../platform/opener/common/opener.js";
import { IQuickInputService, type IQuickPickItem } from "../../../../../platform/quickinput/common/quickInput.js";
import { computeLinks } from "../../../../../editor/common/languages/linkComputer.js";
import { onUnexpectedError } from "../../../../../base/common/errors.js";
import { localize } from "../../../../../nls.js";
import { ITerminalConfigurationService } from "../terminal.js";
import type { ITerminalDimensions, ITerminalScreenHost, IXtermTerminal } from "../../../../services/terminal/browser/terminal.js";
import { h } from "../../../../../base/browser/dom.js";
import { observeResize } from "../../../../../base/browser/observer.js";
import { TerminalResizeDebouncer } from '../terminalResizeDebouncer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Color } from '../../../../../base/common/color.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { searchMatchBackground } from '../../../../../platform/theme/common/colors/searchColors.js';
import { contrastBorder, focusBorder } from '../../../../../platform/theme/common/colors/baseColors.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { XtermAddonImporter } from './xtermAddonImporter.js';
import { updateTerminalFontRendering } from './terminalFontRendering.js';
import { TerminalWidgetManager } from '../widgets/widgetManager.js';
import { TerminalHover } from '../widgets/terminalHoverWidget.js';
import type { ITerminalWidget } from '../widgets/widgets.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';

const addonImporter = new XtermAddonImporter();

/** One persistent xterm renderer bound to exactly one Terminal instance. */
export class XtermTerminal extends Disposable implements IXtermTerminal {
	readonly capabilities = this._register(new TerminalCapabilityStore());
	private readonly lineData = new LineDataEventAddon();
	private readonly widgets = this._register(new TerminalWidgetManager());
	private readonly linkHover = this._register(new MutableDisposable<import('../../../../../base/common/lifecycle.js').IDisposable>());
	readonly element: HTMLDivElement;
	private terminal: Terminal | undefined;
	private fitAddon: FitAddon | undefined;
	private initialization: Promise<void> | undefined;
	private readonly pendingWrites: ((terminal: Terminal) => void)[] = [];
	private focusSource: Element | null | undefined;
	private readonly alternateScroll = new AlternateScrollMode();
	private readonly shellIntegrationAddon: ShellIntegrationAddon;
	private readonly decorationAddon = this._register(new DecorationAddon(this.capabilities));
	private readonly markNavigationAddon = this._register(new MarkNavigationAddon(() => this.instance.capabilities?.has(TerminalCapability.CommandDetection)
		? this.decorationAddon.markers : this.capabilities.get(TerminalCapability.PartialCommandDetection)?.commands ?? this.decorationAddon.markers));
	private visible = false;
	private readonly resizeDebouncer: TerminalResizeDebouncer = this._register(new TerminalResizeDebouncer(
		() => this.visible,
		() => this.terminal ? this : undefined,
		(cols, rows) => this.applyDimensions(cols, rows),
		cols => this.applyDimensions(cols, this.raw.rows),
		rows => this.applyDimensions(this.raw.cols, rows),
	));
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
		readonly instance: ITerminalScreenHost,
		@IThemeService private readonly themeService: IThemeService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IAccessibilitySignalService private readonly signals: IAccessibilitySignalService,
		@ITerminalConfigurationService private readonly configuration: ITerminalConfigurationService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this.shellIntegrationAddon = this._register(instantiation.createInstance(ShellIntegrationAddon, this.capabilities, undefined));
		this.element = h(container.ownerDocument, "div");
		this.element.className = "ash-terminal-instance";
		this.element.hidden = true;
		container.append(this.element);
		this.widgets.attachToElement(this.element);
		this._register(toDisposable(() => {
			this.pendingWrites.length = 0;
			this.element.remove();
		}));
		const commandListeners = this._register(new MutableDisposable<DisposableStore>());
		this._register(this.capabilities.createOnDidAddCapabilityOfTypeEvent(TerminalCapability.CommandDetection)(capability => {
			const listeners = new DisposableStore();
			commandListeners.value = listeners;
			const decorate = (command: import('../../../../../platform/terminal/common/capabilities/capabilities.js').ITerminalCommand, running: boolean) => {
				if (!command.id || !command.marker) return;
				this.decorationAddon.registerCommandDecoration({ commandId: command.id, command: command.command, isTrusted: command.isTrusted, cwd: command.cwd,
					status: running ? 'running' : command.exitCode === undefined ? 'completed' : command.exitCode === 0 ? 'succeeded' : 'failed', exitCode: command.exitCode }, this.instance.processId, command.marker);
			};
			listeners.add(capability.onCommandExecuted(command => decorate(command, true)));
			listeners.add(capability.onCommandFinished(command => decorate(command, false)));
		}));
		this._register(instance.onDidChangeState((state) => {
			this.element.dataset.state = state;
		}));
		this.element.dataset.state = instance.state;
		this._register(observeResize(this.element, () => this.fit()));
		this._register(configuration.onConfigChanged(() => {
			this.linkHover.clear();
			if (!this.terminal) return;
			this.terminal.options = this.screenOptions();
			updateTerminalFontRendering(this.terminal, this.configuration.config.fontRendering);
			this.fit();
		}));
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
			...this.screenOptions(),
			theme: terminalTheme(this.themeService.getColorTheme()),
			linkHandler: { activate: (_event, url) => { void this.openLink(url).catch(onUnexpectedError); } },
		});
		this.terminal = terminal;
		this._register(toDisposable(() => terminal.dispose()));
		this.fitAddon = new FitAddon();
		terminal.loadAddon(this.fitAddon);
		terminal.loadAddon(this.lineData);
		terminal.loadAddon(this.shellIntegrationAddon);
		terminal.loadAddon(this.decorationAddon);
		terminal.loadAddon(this.markNavigationAddon);
		terminal.loadAddon(new WebLinksAddon((_event, url) => { void this.openLink(url).catch(onUnexpectedError); }, {
			hover: (_event, url, viewportRange) => {
				if (!this.configuration.config.showLinkHover || !this.visible) return;
				const rect = terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
				if (!rect?.width || !rect.height) return;
				const cell = (terminal as Terminal & { readonly _core?: IXtermCore; })._core?._renderService?.dimensions?.css?.cell;
				this.linkHover.value = this.widgets.attachWidget(this.instantiation.createInstance(TerminalHover, {
					viewportRange,
					cellDimensions: {
						width: cell?.width && Number.isFinite(cell.width) ? cell.width : rect.width / terminal.cols,
						height: cell?.height && Number.isFinite(cell.height) ? cell.height : rect.height / terminal.rows,
					},
					terminalDimensions: { width: rect.width, height: rect.height },
				}, url));
			},
			leave: () => this.linkHover.clear(),
		}));
		terminal.open(this.element);
		updateTerminalFontRendering(terminal, this.configuration.config.fontRendering);
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

	private screenOptions(): ITerminalOptions {
		const config = this.configuration.config;
		return {
			fontFamily: config.fontFamily, fontSize: config.fontSize,
			letterSpacing: config.letterSpacing, lineHeight: config.lineHeight,
			cursorBlink: config.cursorBlinking, cursorStyle: config.cursorStyle === 'line' ? 'bar' : config.cursorStyle,
			cursorInactiveStyle: config.cursorStyleInactive === 'line' ? 'bar' : config.cursorStyleInactive,
			cursorWidth: config.cursorWidth, scrollback: config.scrollback, minimumContrastRatio: config.minimumContrastRatio,
		};
	}

	public write(data: string | Uint8Array, callback?: () => void): void {
		this.writeWhenReady(terminal => terminal.write(data, callback));
	}

	private writeWhenReady(write: (terminal: Terminal) => void): void {
		if (this.isDisposed) return;
		if (this.terminal) {
			write(this.terminal);
		} else {
			this.pendingWrites.push(write);
		}
	}

	attachWidget(widget: ITerminalWidget): import('../../../../../base/common/lifecycle.js').IDisposable | undefined {
		return this.widgets.attachWidget(widget);
	}

	setVisible(visible: boolean): void {
		if (!visible) this.linkHover.clear();
		if (this.visible === visible) return;
		this.visible = visible;
		if (!visible) this.focusSource = undefined;
		this.element.hidden = !visible;
		if (visible) queueMicrotask(() => this.fit());
	}

	focus(): void {
		if (!this.visible || this.isDisposed) return;
		this.resizeDebouncer.flush();
		this.focusSource = this.element.ownerDocument.activeElement;
		this.terminal?.focus();
	}

	handleShellIntegration(event: TerminalShellIntegrationEvent): void {
		this.shellIntegrationAddon.handleSequence(event);
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
		const SearchAddon = await addonImporter.importAddon('search');
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
		return this.lineData.getBufferText(maxCharacters);
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
				session.add(picker.onDidAccept(() => {
					const item = picker.selectedItems[0];
					if (!item) return;
					return resolve(item.label);
				}));
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
			const dimensions = this.fitAddon.proposeDimensions();
			if (dimensions) void this.resizeDebouncer.resize(Math.min(512, dimensions.cols), Math.min(512, dimensions.rows), false).catch(onUnexpectedError);
		} catch {
			return;
		}
	}

	private applyDimensions(cols: number, rows: number): void {
		if (this.isDisposed || !this.terminal || cols === this.terminal.cols && rows === this.terminal.rows) return;
		this.terminal.resize(cols, rows);
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

	public scrollToPreviousCommand(): void { this.markNavigationAddon.scrollToPreviousMark(); }
	public scrollToNextCommand(): void { this.markNavigationAddon.scrollToNextMark(); }
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
