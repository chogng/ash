import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal, IDecoration } from "@xterm/xterm";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import type { IThemeService } from "../../../../../platform/theme/common/themeService.js";
import type { ITerminalCommandStatusEvent, ITerminalDimensions, ITerminalInstance } from "../../../../services/terminal/common/terminal.js";
import { terminalTheme } from "./terminalTheme.js";
import { AlternateScrollMode } from "./alternateScroll.js";
import { h } from "../../../../../base/browser/dom.js";
import { observeResize } from "../../../../../base/browser/observer.js";

/** One persistent xterm renderer bound to exactly one Terminal instance. */
export class TerminalInstanceWidget extends Disposable {
	readonly element: HTMLDivElement;
	private terminal: Terminal | undefined;
	private fitAddon: FitAddon | undefined;
	private initialization: Promise<void> | undefined;
	private readonly pendingWrites: ((terminal: Terminal) => void)[] = [];
	private focusSource: Element | null | undefined;
	private readonly alternateScroll = new AlternateScrollMode();
	private readonly commandDecorations = new Map<string, TerminalCommandDecoration>();
	private visible = false;

	constructor(container: HTMLElement, readonly instance: ITerminalInstance, private readonly themeService: IThemeService) {
		super();
		this.element = h(container.ownerDocument, "div");
		this.element.className = "ash-terminal-instance";
		this.element.hidden = true;
		container.append(this.element);
		this._register(toDisposable(() => {
			this.pendingWrites.length = 0;
			this.element.remove();
		}));
		this._register(instance.onDidWriteData((data) => this.writeWhenReady(terminal => terminal.write(data))));
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

	initialize(): Promise<void> {
		this.assertNotDisposed();
		this.initialization ??= this.loadTerminal();
		return this.initialization;
	}

	private async loadTerminal(): Promise<void> {
		const [{ Terminal }, { FitAddon }] = await Promise.all([
			import("@xterm/xterm"),
			import("@xterm/addon-fit"),
			import("@xterm/xterm/css/xterm.css"),
		]);
		if (this.isDisposed) return;
		const terminal = new Terminal({
			allowProposedApi: true,
			allowTransparency: false,
			cursorBlink: true,
			cursorStyle: "block",
			fontFamily: "var(--ash-font-family-monospace, Consolas, 'Courier New', monospace)",
			fontSize: 13,
			scrollback: 5_000,
			theme: terminalTheme(this.themeService.getColorTheme()),
		});
		this.terminal = terminal;
		this._register(toDisposable(() => terminal.dispose()));
		this.fitAddon = new FitAddon();
		terminal.loadAddon(this.fitAddon);
		terminal.open(this.element);
		this.registerAlternateScrollMode(terminal);
		this._register(this.themeService.onDidColorThemeChange(theme => {
			terminal.options.theme = terminalTheme(theme);
		}));
		const input = terminal.onData(data => this.instance.write(data));
		this._register(toDisposable(() => input.dispose()));
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

	clear(): void {
		this.writeWhenReady(terminal => terminal.clear());
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
