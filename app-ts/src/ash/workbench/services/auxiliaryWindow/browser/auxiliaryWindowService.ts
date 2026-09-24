import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { cloneDocumentStyles } from "../../../../base/browser/domStylesheets.js";
import { Dimension, type IDimension } from "../../../../base/browser/dom.js";
import { getWindowId, registerWindow } from "../../../../base/browser/window.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { DisposableMap, Disposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

export interface AuxiliaryWindowOpenOptions {
	readonly title?: string;
	readonly width?: number;
	readonly height?: number;
	readonly left?: number;
	readonly top?: number;
}

export interface AuxiliaryWindowBeforeUnloadEvent {
	veto(reason: string): void;
}

/** One same-origin popup whose document is owned by Workbench UI. */
export interface IAuxiliaryWindow extends Disposable {
	readonly id: number;
	readonly window: Window;
	readonly container: HTMLElement;
	readonly onDidLayout: Event<IDimension>;
	readonly onBeforeUnload: Event<AuxiliaryWindowBeforeUnloadEvent>;
	readonly onDidClose: Event<void>;
	layout(): void;
}

export interface IAuxiliaryWindowService extends Disposable {
	readonly onDidOpenWindow: Event<IAuxiliaryWindow>;
	open(options?: AuxiliaryWindowOpenOptions): Promise<IAuxiliaryWindow>;
	getWindow(id: number): IAuxiliaryWindow | undefined;
}

export const IAuxiliaryWindowService = createServiceIdentifier<IAuxiliaryWindowService>("auxiliaryWindowService");

/** Browser implementation used by both the web and Electron renderer workbenches. */
export class BrowserAuxiliaryWindowService extends Disposable implements IAuxiliaryWindowService {
	private readonly windows = this._register(new DisposableMap<number, BrowserAuxiliaryWindow>());
	private readonly windowListeners = this._register(new DisposableMap<number, IDisposable>());
	private readonly openEmitter = this._register(new Emitter<IAuxiliaryWindow>());
	readonly onDidOpenWindow: Event<IAuxiliaryWindow> = this.openEmitter.event;

	constructor(private readonly opener: Window) {
		super();
	}

	async open(options: AuxiliaryWindowOpenOptions = {}): Promise<IAuxiliaryWindow> {
		const width = finiteDimension(options.width, 960);
		const height = finiteDimension(options.height, 720);
		const features = [
			"popup=yes",
			`width=${width}`,
			`height=${height}`,
			options.left === undefined ? undefined : `left=${Math.round(options.left)}`,
			options.top === undefined ? undefined : `top=${Math.round(options.top)}`,
		].filter((feature): feature is string => feature !== undefined).join(",");
		const target = this.opener.open("about:blank", "", features);
		if (!target) throw new Error("The browser blocked opening an auxiliary editor window");
		try {
			target.opener = null;
		} catch {
			// Some browser WindowProxy implementations expose a read-only opener.
		}
		const auxiliary = new BrowserAuxiliaryWindow(this.opener, target, options.title ?? "Editor");
		this.windows.set(auxiliary.id, auxiliary);
		this.windowListeners.set(auxiliary.id, auxiliary.onDidClose(() => {
			this.windowListeners.deleteAndDispose(auxiliary.id);
			this.windows.deleteAndDispose(auxiliary.id);
		}));
		this.openEmitter.fire(auxiliary);
		auxiliary.layout();
		return auxiliary;
	}

	getWindow(id: number): IAuxiliaryWindow | undefined {
		for (const [candidateId, window] of this.windows) {
			if (candidateId === id) return window;
		}
		return undefined;
	}
}

class BrowserAuxiliaryWindow extends Disposable implements IAuxiliaryWindow {
	private readonly layoutEmitter = this._register(new Emitter<IDimension>());
	private readonly beforeUnloadEmitter = this._register(new Emitter<AuxiliaryWindowBeforeUnloadEvent>());
	private readonly closeEmitter = this._register(new Emitter<void>());
	readonly onDidLayout = this.layoutEmitter.event;
	readonly onBeforeUnload = this.beforeUnloadEmitter.event;
	readonly onDidClose = this.closeEmitter.event;
	readonly id: number;
	readonly container: HTMLElement;
	private closed = false;

	constructor(sourceWindow: Window, readonly window: Window, title: string) {
		super();
		this._register(registerWindow(window));
		const id = getWindowId(window);
		if (id === undefined) throw new Error("Auxiliary window registration did not produce an identity");
		this.id = id;
		this._register(cloneDocumentStyles(sourceWindow.document, window.document));
		window.document.title = title;
		window.document.body.replaceChildren();
		window.document.documentElement.classList.add("ash-auxiliary-window");
		window.document.body.classList.add("ash-auxiliary-window-body");
		this.container = h(window.document, "main");
		this.container.className = "ash-auxiliary-window-container";
		this.container.setAttribute("aria-label", title);
		window.document.body.append(this.container);
		this._register(addDisposableListener(window, "resize", () => this.layout()));
		this._register(addDisposableListener(window, "beforeunload", event => this.handleBeforeUnload(event as BeforeUnloadEvent)));
		this._register(addDisposableListener(window, "unload", () => this.publishClosed()));
		this._register(toDisposable(() => {
			this.container.remove();
			window.document.documentElement.classList.remove("ash-auxiliary-window");
			window.document.body.classList.remove("ash-auxiliary-window-body");
			if (!this.closed && !window.closed) window.close();
			this.publishClosed();
		}));
	}

	layout(): void {
		const width = Math.max(0, this.container.clientWidth || this.window.innerWidth || 0);
		const height = Math.max(0, this.container.clientHeight || this.window.innerHeight || 0);
		this.layoutEmitter.fire(new Dimension(width, height));
	}

	private handleBeforeUnload(event: BeforeUnloadEvent): void {
		let reason: string | undefined;
		this.beforeUnloadEmitter.fire({ veto: candidate => { reason ??= candidate; } });
		if (!reason) return;
		event.preventDefault();
		event.returnValue = reason;
	}

	private publishClosed(): void {
		if (this.closed) return;
		this.closed = true;
		this.closeEmitter.fire();
	}
}

function finiteDimension(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(320, Math.round(value)) : fallback;
}
