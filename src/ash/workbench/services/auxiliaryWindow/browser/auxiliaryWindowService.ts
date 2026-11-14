import { addDisposableListener, Dimension, h, type IDimension } from '../../../../base/browser/dom.js';
import { cloneDocumentStyles } from '../../../../base/browser/domStylesheets.js';
import { observeMutations } from '../../../../base/browser/observer.js';
import { setIconResolver } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { getWindowId, registerWindow } from '../../../../base/browser/window.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { cancelOnDispose } from '../../../../base/common/cancellation.js';
import { CancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { DisposableMap, Disposable, DisposableStore, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { getIconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IAuxiliaryWindowState } from '../../../../platform/window/common/window.js';
import { localize } from '../../../../nls.js';
import { getContainerDimension } from '../../../../platform/layout/browser/layoutService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { BaseWindow } from '../../../browser/window.js';
import { IHostService } from '../../host/browser/host.js';
import type { CodeWindow } from '../../../../base/browser/window.js';

const WORKBENCH_ROOT_CLASSES = ['ash-reduce-motion', 'ash-enable-motion', 'ash-reduce-transparency', 'ash-underline-links', 'hc-black', 'hc-light', 'ash-high-contrast'] as const;
const WORKBENCH_ROOT_ATTRIBUTES = ['data-os', 'data-runtime', 'data-workbench-state', 'data-color-theme', 'data-color-scheme'] as const;

export interface AuxiliaryWindowBounds {
	readonly width: number;
	readonly height: number;
	readonly left: number;
	readonly top: number;
}

export interface AuxiliaryWindowState extends AuxiliaryWindowBounds {
	readonly featureWidthOffset: number;
	readonly featureHeightOffset: number;
	readonly zoomLevel?: number;
	readonly alwaysOnTop?: boolean;
	readonly mode?: IAuxiliaryWindowState['mode'];
}

export interface AuxiliaryWindowOpenOptions extends Partial<IAuxiliaryWindowState> {
	readonly title?: string;
	/** Remember the last window geometry for this feature. */
	readonly stateKey?: string;
	readonly featureWidthOffset?: number;
	readonly featureHeightOffset?: number;
	readonly width?: number;
	readonly height?: number;
	readonly left?: number;
	readonly top?: number;
}

export interface AuxiliaryWindowBeforeUnloadEvent {
	veto(reason: string): void;
	/** Pause unloading while the owner prepares to close. */
	join(close: () => Promise<boolean>): void;
}

/** One same-origin popup whose document is owned by Workbench UI. */
export interface IAuxiliaryWindow extends Disposable {
	readonly id: number;
	readonly window: Window;
	readonly container: HTMLElement;
	/** Participants lay out hosted Parts before completion is published. */
	readonly onWillLayout: Event<IDimension>;
	readonly onDidLayout: Event<IDimension>;
	readonly onBeforeUnload: Event<AuxiliaryWindowBeforeUnloadEvent>;
	readonly onDidClose: Event<void>;
	readonly whenStylesHaveLoaded: Promise<void>;
	/** Native hosts expose their authoritative pin state; browser popups omit it. */
	readonly alwaysOnTop?: {
		readonly value: boolean;
		readonly onDidChange: Event<boolean>;
		set(value: boolean): Promise<void>;
	};
	focus(): Promise<void>;
	layout(): void;
	createState(): AuxiliaryWindowState;
}

export interface IAuxiliaryWindowService extends Disposable {
	readonly onDidOpenWindow: Event<IAuxiliaryWindow>;
	open(options?: AuxiliaryWindowOpenOptions): Promise<IAuxiliaryWindow>;
	getWindow(id: number): IAuxiliaryWindow | undefined;
}

export const IAuxiliaryWindowService = createServiceIdentifier<IAuxiliaryWindowService>('auxiliaryWindowService');

/** Browser implementation used by both the web and Electron renderer workbenches. */
export class BrowserAuxiliaryWindowService extends Disposable implements IAuxiliaryWindowService {
	private readonly windows = this._register(new DisposableMap<number, AuxiliaryWindow>());
	private readonly windowListeners = this._register(new DisposableMap<number, IDisposable>());
	private readonly openEmitter = this._register(new Emitter<IAuxiliaryWindow>());
	readonly onDidOpenWindow: Event<IAuxiliaryWindow> = this.openEmitter.event;

	constructor(
		protected readonly opener: Window,
		protected readonly workbenchRoot: HTMLElement,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	async open(options: AuxiliaryWindowOpenOptions = {}): Promise<IAuxiliaryWindow> {
		this.assertNotDisposed();
		const { stateKey } = options;
		const restored = stateKey === undefined ? undefined : parseAuxiliaryWindowState(this.storageService.get(stateKey, StorageScope.APPLICATION));
		const width = finiteDimension((options.width ?? restored?.width ?? 960) + (options.width === undefined ? restored?.featureWidthOffset ?? 0 : options.featureWidthOffset ?? 0), 960);
		const height = finiteDimension((options.height ?? restored?.height ?? 720) + (options.height === undefined ? restored?.featureHeightOffset ?? 0 : options.featureHeightOffset ?? 0), 720);
		const left = options.left ?? restored?.left;
		const top = options.top ?? restored?.top;
		const positionKeys = this.workbenchRoot.getAttribute('data-runtime') === 'electron' && left !== undefined && top !== undefined
			? ['x', 'y'] as const
			: ['left', 'top'] as const;
		const features = [
			'popup=yes',
			options.zoomLevel === undefined ? undefined : `window-zoom-level=${options.zoomLevel}`,
			options.alwaysOnTop === undefined ? undefined : `window-always-on-top=${options.alwaysOnTop ? 'yes' : 'no'}`,
			options.mode === 'maximized' ? 'window-maximized=yes' : undefined,
			options.mode === 'fullscreen' ? 'window-fullscreen=yes' : undefined,
			`width=${width}`,
			`height=${height}`,
			left === undefined ? undefined : `${positionKeys[0]}=${Math.round(left)}`,
			top === undefined ? undefined : `${positionKeys[1]}=${Math.round(top)}`,
		].filter((feature): feature is string => feature !== undefined).join(',');
		const target = this.opener.open('about:blank', `ash-auxiliary-${generateUuid()}`, features);
		if (!target) throw new Error('The browser blocked opening an auxiliary editor window');
		try {
			target.opener = null;
		} catch {
			// Some browser WindowProxy implementations expose a read-only opener.
		}
		const opening = this._register(new DisposableStore());
		const closeTarget = opening.add(toDisposable(() => {
			if (!target.closed) target.close();
		}));
		const cancellation = cancelOnDispose(opening);
		try {
			const auxiliary = opening.add(this.createAuxiliaryWindow(target, options.title ?? localize({ bundle: 'ash', key: 'auxiliaryWindow.editor' }, 'Editor')));
			opening.add(auxiliary.onDidClose(() => opening.dispose()));
			const windowId = await raceCancellationError(auxiliary.initialize(), cancellation);
			if (target.closed) throw new CancellationError();
			auxiliary.recordFrameOffsets();
			auxiliary.register(windowId);
			if (target.closed || cancellation.isCancellationRequested) throw new CancellationError();

			opening.delete(closeTarget);
			opening.delete(auxiliary);
			this.windows.set(auxiliary.id, auxiliary);
			this.windowListeners.set(auxiliary.id, auxiliary.onDidClose(() => {
				this.windowListeners.deleteAndDispose(auxiliary.id);
				const closedWindow = this.windows.deleteAndLeak(auxiliary.id);
				// Release the window after every close listener has received the event.
				queueMicrotask(() => closedWindow?.dispose());
				if (stateKey !== undefined) {
					this.storageService.store(stateKey, JSON.stringify(auxiliary.createState()), StorageScope.APPLICATION, StorageTarget.MACHINE);
				}
			}));
			this.openEmitter.fire(auxiliary);
			if (target.closed || auxiliary.isDisposed) throw new CancellationError();
			auxiliary.startLayout();
			return auxiliary;
		} finally {
			this._store.delete(opening);
			opening.dispose();
		}
	}

	protected createAuxiliaryWindow(target: Window, title: string): AuxiliaryWindow {
		return this.instantiationService.createInstance(AuxiliaryWindow, this.opener, target, this.workbenchRoot, title);
	}

	getWindow(id: number): IAuxiliaryWindow | undefined {
		for (const [candidateId, window] of this.windows) {
			if (candidateId === id) return window;
		}
		return undefined;
	}
}

export class AuxiliaryWindow extends BaseWindow implements IAuxiliaryWindow {
	readonly alwaysOnTop: IAuxiliaryWindow['alwaysOnTop'] = undefined;
	private readonly willLayoutEmitter = this._register(new Emitter<IDimension>());
	private readonly layoutEmitter = this._register(new Emitter<IDimension>());
	private readonly beforeUnloadEmitter = this._register(new Emitter<AuxiliaryWindowBeforeUnloadEvent>());
	private readonly closeEmitter = this._register(new Emitter<void>());
	readonly onWillLayout = this.willLayoutEmitter.event;
	readonly onDidLayout = this.layoutEmitter.event;
	readonly onBeforeUnload = this.beforeUnloadEmitter.event;
	readonly onDidClose = this.closeEmitter.event;
	private windowId: number | undefined;
	get id(): number {
		if (this.windowId === undefined) throw new Error('Auxiliary window is not registered');
		return this.windowId;
	}
	readonly container: HTMLElement;
	readonly whenStylesHaveLoaded: Promise<void>;
	private closed = false;
	private pendingClose = false;
	private closeApproved = false;
	private layoutEnabled = false;
	private closingState: AuxiliaryWindowState | undefined;
	private featureWidthOffset = 0;
	private featureHeightOffset = 0;

	constructor(
		sourceWindow: Window,
		readonly window: Window,
		workbenchRoot: HTMLElement,
		title: string,
		@IThemeService themeService: IThemeService,
		@IHostService hostService: IHostService,
	) {
		super(window as CodeWindow, hostService);
		const targetDocument = window.document;
		const { documentElement, body } = targetDocument;
		this.container = h(sourceWindow.document, 'main');
		this._register(toDisposable(() => {
			if (this.layoutEnabled && !window.closed) this.closingState ??= this.readCurrentState();
			this.container.remove();
			documentElement.classList.remove('ash-auxiliary-window');
			body.classList.remove('ash-auxiliary-window-body');
			if (!this.closed && !window.closed) window.close();
			this.publishClosed();
		}));
		try {
			this.whenStylesHaveLoaded = this._register(cloneDocumentStyles(sourceWindow.document, targetDocument)).whenStylesHaveLoaded;
			documentElement.lang = sourceWindow.document.documentElement.lang;
			documentElement.dir = sourceWindow.document.documentElement.dir;
			body.replaceChildren();
			documentElement.classList.add('ash-auxiliary-window');
			body.classList.add('ash-auxiliary-window-body');
			this.container.className = 'ash-auxiliary-window-container ash-workbench';
			this.container.setAttribute('aria-label', title);
			body.append(this.container);
			this._register(observeMutations(workbenchRoot, () => this.syncWorkbenchRoot(workbenchRoot), {
				attributes: true,
				attributeFilter: ['class', ...WORKBENCH_ROOT_ATTRIBUTES],
			}));
			this.syncWorkbenchRoot(workbenchRoot);
			const updateIcons = (): void => setIconResolver(
				targetDocument,
				icon => getIconDefinition(icon, themeService.getProductIconTheme().icons),
			);
			updateIcons();
			this._register(themeService.onDidProductIconThemeChange(updateIcons));
			this._register(toDisposable(() => setIconResolver(targetDocument, icon => getIconDefinition(icon))));
			this._register(addDisposableListener(window, 'resize', () => this.layout()));
			this._register(addDisposableListener(window, 'beforeunload', event => this.handleBeforeUnload(event as BeforeUnloadEvent)));
			this._register(addDisposableListener(window, 'unload', () => this.publishClosed()));
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	register(windowId: number | undefined): void {
		const registration = registerWindow(this.window, windowId);
		if (this.isDisposed) {
			registration.dispose();
			throw new CancellationError();
		}
		this._register(registration);
		this.windowId = getWindowId(this.window)!;
	}

	async initialize(): Promise<number | undefined> {
		await this.whenStylesHaveLoaded;
		return undefined;
	}

	startLayout(): void {
		this.layoutEnabled = true;
		this.layout();
	}

	async focus(): Promise<void> {
		this.window.focus();
	}

	layout(): void {
		if (!this.layoutEnabled || this.isDisposed || this.closed) return;
		const measured = getContainerDimension(this.container);
		const dimension = new Dimension(
			Math.max(0, measured.width || this.window.innerWidth || 0),
			Math.max(0, measured.height || this.window.innerHeight || 0),
		);
		this.willLayoutEmitter.fire(dimension);
		this.layoutEmitter.fire(dimension);
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
			if (className === 'hc-black' || className === 'hc-light' || className === 'ash-high-contrast') {
				this.window.document.documentElement.classList.toggle(className, source.classList.contains(className));
			}
		}
		for (const name of WORKBENCH_ROOT_ATTRIBUTES) {
			const value = source.getAttribute(name);
			if (value === null) this.container.removeAttribute(name);
			else this.container.setAttribute(name, value);
			if (name === 'data-color-theme' || name === 'data-color-scheme') {
				if (value === null) this.window.document.documentElement.removeAttribute(name);
				else this.window.document.documentElement.setAttribute(name, value);
			}
		}
	}

	private handleBeforeUnload(event: BeforeUnloadEvent): void {
		if (this.closeApproved) {
			this.closeApproved = false;
			if (this.layoutEnabled) this.closingState = this.readCurrentState();
			return;
		}
		if (this.pendingClose) {
			this.preventUnload(event);
			return;
		}
		let reason: string | undefined;
		let close: (() => Promise<boolean>) | undefined;
		this.beforeUnloadEmitter.fire({
			veto: candidate => { reason ??= candidate; },
			join: participant => { close ??= participant; },
		});
		const confirm = !reason && this.layoutEnabled && this.shouldConfirmClose();
		if (!reason && !close && !confirm) {
			if (this.layoutEnabled) this.closingState = this.readCurrentState();
			return;
		}
		this.preventUnload(event, reason);
		this.pendingClose = true;
		void this.prepareClose(reason, close, confirm).catch(onUnexpectedError).finally(() => {
			this.pendingClose = false;
		});
	}

	private async prepareClose(reason: string | undefined, close: (() => Promise<boolean>) | undefined, confirm: boolean): Promise<void> {
		// Let the current beforeunload dispatch finish before showing a dialog or closing again.
		await Promise.resolve();
		if (this.isDisposed || this.window.closed) return;
		if (reason) {
			await this.showCloseVeto(reason);
			return;
		}
		if (confirm && !await this.confirmClose()) return;
		if (this.isDisposed || this.window.closed) return;
		if (close && !await close()) return;
		if (this.isDisposed || this.window.closed) return;
		this.closeApproved = true;
		try {
			await this.closeWindow();
		} catch (error) {
			this.closeApproved = false;
			throw error;
		}
	}

	protected preventUnload(event: BeforeUnloadEvent, reason?: string): void {
		event.preventDefault();
		if (reason) event.returnValue = reason;
	}

	protected shouldConfirmClose(): boolean {
		return false;
	}

	protected confirmClose(): Promise<boolean> {
		return Promise.resolve(true);
	}

	protected showCloseVeto(_reason: string): Promise<void> {
		return Promise.resolve();
	}

	protected async closeWindow(): Promise<void> {
		this.window.close();
	}

	private publishClosed(): void {
		if (this.closed) return;
		this.closed = true;
		this.closeEmitter.fire();
	}
}

function finiteDimension(value: number | undefined, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(320, Math.round(value)) : fallback;
}

export function parseAuxiliaryWindowState(raw: string | undefined): AuxiliaryWindowState | undefined {
	if (!raw) return undefined;
	let value: unknown;
	try { value = JSON.parse(raw); } catch { return undefined; }
	if (typeof value !== 'object' || value === null) return undefined;
	const state = value as Partial<AuxiliaryWindowState>;
	if (![state.width, state.height, state.left, state.top, state.featureWidthOffset, state.featureHeightOffset].every(candidate => typeof candidate === 'number' && Number.isFinite(candidate))) return undefined;
	if (state.width! <= 0 || state.height! <= 0) return undefined;
	if (state.zoomLevel !== undefined && (typeof state.zoomLevel !== 'number' || !Number.isFinite(state.zoomLevel) || state.zoomLevel < -8 || state.zoomLevel > 8)
		|| state.alwaysOnTop !== undefined && typeof state.alwaysOnTop !== 'boolean'
		|| state.mode !== undefined && !['normal', 'maximized', 'fullscreen'].includes(state.mode)) return undefined;
	return state as AuxiliaryWindowState;
}
