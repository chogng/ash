import { addDisposableListener, Dimension, h, type IDimension } from "../../../../base/browser/dom.js";
import { cloneDocumentStyles } from "../../../../base/browser/domStylesheets.js";
import { observeMutations } from "../../../../base/browser/observer.js";
import { setIconResolver } from "../../../../base/browser/ui/lxicons/lxicon.js";
import { getWindowId, registerWindow } from "../../../../base/browser/window.js";
import { generateUuid } from "../../../../base/common/uuid.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { DisposableMap, Disposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { IStorageService, StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import { bindColorTheme } from "../../../../platform/theme/browser/themeStyles.js";
import { getIconDefinition } from "../../../../platform/theme/common/iconRegistry.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";

const WORKBENCH_ROOT_CLASSES = ["ash-reduce-motion", "ash-enable-motion", "ash-reduce-transparency", "ash-underline-links"] as const;
const WORKBENCH_ROOT_ATTRIBUTES = ["data-os", "data-runtime", "data-workbench-state"] as const;
const AUXILIARY_WINDOW_STATE_KEY = 'auxiliaryEditorWindowState';

export interface AuxiliaryWindowBounds {
	readonly width: number;
	readonly height: number;
	readonly left: number;
	readonly top: number;
}

export interface AuxiliaryWindowState extends AuxiliaryWindowBounds {
	readonly featureWidthOffset: number;
	readonly featureHeightOffset: number;
}

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
	createState(): AuxiliaryWindowState;
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

	constructor(
		private readonly opener: Window,
		private readonly workbenchRoot: HTMLElement,
		@IThemeService private readonly themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
	}

	async open(options: AuxiliaryWindowOpenOptions = {}): Promise<IAuxiliaryWindow> {
		const restored = parseWindowBounds(this.storageService.get(AUXILIARY_WINDOW_STATE_KEY, StorageScope.APPLICATION));
		const width = finiteDimension(options.width ?? (restored ? restored.width + restored.featureWidthOffset : undefined), 960);
		const height = finiteDimension(options.height ?? (restored ? restored.height + restored.featureHeightOffset : undefined), 720);
		const left = options.left ?? restored?.left;
		const top = options.top ?? restored?.top;
		const positionKeys = this.workbenchRoot.getAttribute('data-runtime') === 'electron' && left !== undefined && top !== undefined
			? ['x', 'y'] as const
			: ['left', 'top'] as const;
		const features = [
			"popup=yes",
			`width=${width}`,
			`height=${height}`,
			left === undefined ? undefined : `${positionKeys[0]}=${Math.round(left)}`,
			top === undefined ? undefined : `${positionKeys[1]}=${Math.round(top)}`,
		].filter((feature): feature is string => feature !== undefined).join(",");
		const target = this.opener.open("about:blank", `ash-auxiliary-${generateUuid()}`, features);
		if (!target) throw new Error("The browser blocked opening an auxiliary editor window");
		try {
			target.opener = null;
		} catch {
			// Some browser WindowProxy implementations expose a read-only opener.
		}
		const auxiliary = new BrowserAuxiliaryWindow(
			this.opener,
			target,
			this.workbenchRoot,
			this.themeService,
			options.title ?? "Editor",
		);
		this.windows.set(auxiliary.id, auxiliary);
		this.windowListeners.set(auxiliary.id, auxiliary.onDidClose(() => {
			this.storageService.store(AUXILIARY_WINDOW_STATE_KEY, JSON.stringify(auxiliary.createState()), StorageScope.APPLICATION, StorageTarget.MACHINE);
			this.windowListeners.deleteAndDispose(auxiliary.id);
			const closedWindow = this.windows.deleteAndLeak(auxiliary.id);
			// Release the window after every close listener has received the event.
			queueMicrotask(() => closedWindow?.dispose());
		}));
		await auxiliary.whenStylesHaveLoaded;
		if (this.windows.get(auxiliary.id) !== auxiliary) throw new Error('The auxiliary editor window closed before its styles loaded');
		auxiliary.recordFrameOffsets();
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
	readonly whenStylesHaveLoaded: Promise<void>;
	private closed = false;
	private closingState: AuxiliaryWindowState | undefined;
	private featureWidthOffset = 0;
	private featureHeightOffset = 0;

	constructor(
		sourceWindow: Window,
		readonly window: Window,
		workbenchRoot: HTMLElement,
		themeService: IThemeService,
		title: string,
	) {
		super();
		this._register(registerWindow(window));
		const id = getWindowId(window);
		if (id === undefined) throw new Error("Auxiliary window registration did not produce an identity");
		this.id = id;
		this.whenStylesHaveLoaded = this._register(cloneDocumentStyles(sourceWindow.document, window.document)).whenStylesHaveLoaded;
		window.document.documentElement.lang = sourceWindow.document.documentElement.lang;
		window.document.documentElement.dir = sourceWindow.document.documentElement.dir;
		window.document.body.replaceChildren();
		window.document.documentElement.classList.add("ash-auxiliary-window");
		window.document.body.classList.add("ash-auxiliary-window-body");
		this.container = h(sourceWindow.document, "main");
		this.container.className = "ash-auxiliary-window-container ash-workbench";
		this.container.setAttribute("aria-label", title);
		window.document.body.append(this.container);
		this._register(observeMutations(workbenchRoot, () => this.syncWorkbenchRoot(workbenchRoot), {
			attributes: true,
			attributeFilter: ["class", ...WORKBENCH_ROOT_ATTRIBUTES],
		}));
		this.syncWorkbenchRoot(workbenchRoot);
		this._register(bindColorTheme(themeService, this.container));
		const targetDocument = window.document;
		const updateIcons = (): void => setIconResolver(
			targetDocument,
			icon => getIconDefinition(icon, themeService.getProductIconTheme().icons),
		);
		updateIcons();
		this._register(themeService.onDidProductIconThemeChange(updateIcons));
		this._register(toDisposable(() => setIconResolver(targetDocument, icon => getIconDefinition(icon))));
		this._register(addDisposableListener(window, "resize", () => this.layout()));
		this._register(addDisposableListener(window, "beforeunload", event => this.handleBeforeUnload(event as BeforeUnloadEvent)));
		this._register(addDisposableListener(window, "unload", () => this.publishClosed()));
		this._register(toDisposable(() => {
			this.closingState ??= this.readCurrentState();
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

	recordFrameOffsets(): void {
		// Browser popup features size the content area; Electron receives outer bounds in the main process.
		// Capture the browser frame while live because dimensions can collapse during unload.
		const direction = this.container.getAttribute('data-runtime') === 'electron' ? 0 : -1;
		this.featureWidthOffset = direction * (this.window.outerWidth - this.window.innerWidth);
		this.featureHeightOffset = direction * (this.window.outerHeight - this.window.innerHeight);
	}

	createState(): AuxiliaryWindowState {
		return this.closingState ?? this.readCurrentState();
	}

	private readCurrentState(): AuxiliaryWindowState {
		return {
			width: finiteDimension(this.window.outerWidth || this.window.innerWidth, 960),
			height: finiteDimension(this.window.outerHeight || this.window.innerHeight, 720),
			left: Math.round(this.window.screenX),
			top: Math.round(this.window.screenY),
			featureWidthOffset: this.featureWidthOffset,
			featureHeightOffset: this.featureHeightOffset,
		};
	}

	private syncWorkbenchRoot(source: HTMLElement): void {
		for (const className of WORKBENCH_ROOT_CLASSES) {
			this.container.classList.toggle(className, source.classList.contains(className));
		}
		for (const name of WORKBENCH_ROOT_ATTRIBUTES) {
			const value = source.getAttribute(name);
			if (value === null) this.container.removeAttribute(name);
			else this.container.setAttribute(name, value);
		}
	}

	private handleBeforeUnload(event: BeforeUnloadEvent): void {
		let reason: string | undefined;
		this.beforeUnloadEmitter.fire({ veto: candidate => { reason ??= candidate; } });
		if (!reason) {
			this.closingState = this.readCurrentState();
			return;
		}
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

function parseWindowBounds(raw: string | undefined): AuxiliaryWindowState | undefined {
	if (!raw) return undefined;
	let value: unknown;
	try { value = JSON.parse(raw); } catch { return undefined; }
	if (typeof value !== 'object' || value === null) return undefined;
	const state = value as Partial<AuxiliaryWindowState>;
	if (![state.width, state.height, state.left, state.top, state.featureWidthOffset, state.featureHeightOffset].every(candidate => typeof candidate === 'number' && Number.isFinite(candidate))) return undefined;
	if (state.width! < 320 || state.height! < 320) return undefined;
	return state as AuxiliaryWindowState;
}
