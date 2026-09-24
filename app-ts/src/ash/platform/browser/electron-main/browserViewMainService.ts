import { WebContentsView, type BrowserWindow, type Event as ElectronEvent, type WebContents } from "electron/main";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import { type BrowserViewEvent, type BrowserViewTargetId, type IBrowserViewCreateRequest, type IBrowserViewLayoutRequest, type IBrowserViewNavigateRequest, type IBrowserViewState, type IBrowserViewVisibilityRequest, normalizeBrowserViewUrl } from "../common/browserView.js";
import { type BrowserViewNavigation, directBrowserViewNavigation, type IBrowserViewNavigationResolver } from "../common/browserViewNavigation.js";
import type { IBrowserViewMainService } from "./browserViewIpc.js";
import { BrowserTargetRegistry } from "./browserTargetRegistry.js";

interface BrowserTarget {
	readonly id: BrowserViewTargetId;
	readonly view: WebContentsView;
	readonly disposables: DisposableStack;
	readonly cancellation: AbortController;
	readonly navigations: Set<BrowserViewNavigation>;
	url: string;
	navigation: BrowserViewNavigation;
	pendingNavigation?: BrowserViewNavigation;
	navigationTurn: Promise<void>;
	laidOut: boolean;
	visible: boolean;
}

export interface BrowserViewMainServiceOptions {
	readonly window: BrowserWindow;
	readonly registry: BrowserTargetRegistry;
	readonly emitEvent: (event: BrowserViewEvent) => void;
	readonly navigationResolver?: IBrowserViewNavigationResolver;
}

/**
 * Electron main's authoritative owner of isolated embedded browser targets.
 *
 * Every target belongs to one workbench window, starts hidden, and uses an
 * ephemeral session with no Node integration or granted web permissions.
 */
export class BrowserViewMainService extends Disposable
	implements IBrowserViewMainService {
	private readonly window: BrowserWindow;
	private readonly registry: BrowserTargetRegistry;
	private readonly emitEvent: (event: BrowserViewEvent) => void;
	private readonly navigationResolver: IBrowserViewNavigationResolver;
	private readonly targets = new Map<BrowserViewTargetId, BrowserTarget>();
	private readonly cancellation = new AbortController();
	private disposing = false;

	constructor(options: BrowserViewMainServiceOptions) {
		super();
		this.window = options.window;
		this.registry = options.registry;
		this.emitEvent = options.emitEvent;
		this.navigationResolver = options.navigationResolver ?? {
			resolve: (url) => Promise.resolve(directBrowserViewNavigation(url)),
		};
		this._register(toDisposable(() => {
			this.disposing = true;
			this.cancellation.abort();
			for (const target of [...this.targets.values()]) {
				this.releaseTarget(target, true);
			}
		}));
	}

	async createTarget(request: IBrowserViewCreateRequest): Promise<IBrowserViewState> {
		const initialUrl = normalizeBrowserViewUrl(request.url);
		const navigation = await this.navigationResolver.resolve(initialUrl, this.cancellation.signal);
		if (this.disposing || this.cancellation.signal.aborted) {
			navigation.release();
			throw new Error("BrowserViewServiceDisposed");
		}
		const targetId = `browser_target_${randomUUID()}`;
		let view: WebContentsView;
		try {
			view = new WebContentsView({
				webPreferences: {
					contextIsolation: true,
					nodeIntegration: false,
					sandbox: true,
					webviewTag: false,
					partition: `ash-browser-${randomUUID()}`,
				},
			});
		} catch (error) {
			navigation.release();
			throw error;
		}
		const target: BrowserTarget = {
			id: targetId,
			view,
			disposables: new DisposableStack(),
			cancellation: new AbortController(),
			navigations: new Set([navigation]),
			url: navigation.requestedUrl,
			navigation,
			navigationTurn: Promise.resolve(),
			laidOut: false,
			visible: false,
		};
		this.targets.set(targetId, target);

		try {
			this.registry.register(targetId, view);
			view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
			view.setVisible(false);
			this.window.contentView.addChildView(view);
			this.configureSecurity(target);
			this.listen(target);
			this.emit({ type: "created", state: this.state(target) });
			void view.webContents.loadURL(navigation.loadUrl).catch(() => {
				// did-fail-load publishes the structured failure event.
			});
			return this.state(target);
		} catch (error) {
			this.releaseTarget(target, true);
			throw error;
		}
	}

	observe(targetId: string): IBrowserViewState {
		return this.state(this.target(targetId));
	}

	layout(request: IBrowserViewLayoutRequest): void {
		const target = this.target(request.targetId);
		const scale = this.window.webContents.getZoomFactor();
		const { x, y, width, height } = request.bounds;
		target.view.setBounds({ x: Math.round(x * scale), y: Math.round(y * scale), width: Math.round(width * scale), height: Math.round(height * scale) });
		target.laidOut = true;
	}

	setVisibility(request: IBrowserViewVisibilityRequest): void {
		const target = this.target(request.targetId);
		if (request.visible && !target.laidOut) {
			throw new Error("BrowserTargetNotLaidOut");
		}
		if (target.visible === request.visible) return;
		target.visible = request.visible;
		target.view.setVisible(request.visible);
		this.emitState(target);
	}

	async navigate(request: IBrowserViewNavigateRequest): Promise<void> {
		const target = this.target(request.targetId);
		await this.queueNavigation(target, normalizeBrowserViewUrl(request.url));
	}

	goBack(targetId: string): void {
		const history = this.target(targetId).view.webContents.navigationHistory;
		if (history.canGoBack()) history.goBack();
	}

	goForward(targetId: string): void {
		const history = this.target(targetId).view.webContents.navigationHistory;
		if (history.canGoForward()) history.goForward();
	}

	reload(targetId: string): void {
		this.target(targetId).view.webContents.reload();
	}

	stop(targetId: string): void {
		this.target(targetId).view.webContents.stop();
	}

	focus(targetId: string): void {
		const target = this.target(targetId);
		if (target.visible) { target.view.webContents.focus(); }
	}

	close(targetId: string): void {
		this.releaseTarget(this.target(targetId), true);
	}

	private configureSecurity(target: BrowserTarget): void {
		const contents = target.view.webContents;
		const browserSession = contents.session;
		browserSession.setPermissionCheckHandler(() => false);
		browserSession.setPermissionRequestHandler(
			(_webContents, _permission, callback) => callback(false),
		);
		browserSession.setDevicePermissionHandler(() => false);

		const preventDownload = (event: ElectronEvent): void =>
			event.preventDefault();
		browserSession.on("will-download", preventDownload);
		target.disposables.use(toDisposable(() =>
			browserSession.removeListener("will-download", preventDownload)
		));

		contents.setWindowOpenHandler(({ url }) => {
			try {
				this.emit({
					type: "openRequested",
					targetId: target.id,
					url: normalizeBrowserViewUrl(url),
				});
			} catch {
				// Invalid and privileged URLs are denied without entering renderer IPC.
			}
			return { action: "deny" };
		});
	}

	private listen(target: BrowserTarget): void {
		const contents = target.view.webContents;
		this.on(contents, target, "before-input-event", (event: ElectronEvent, input: Electron.Input) => {
			if (input.type === 'keyDown' && (input.key === 'F6' || ((input.control || input.meta) && input.key.toLowerCase() === 'l'))) {
				event.preventDefault();
				this.window.webContents.focus();
				this.emit({ type: 'focusAddress', targetId: target.id });
			}
		});
		this.on(contents, target, "did-start-loading", () =>
			this.emitState(target));
		this.on(contents, target, "did-stop-loading", () =>
			this.emitState(target));
		this.on(contents, target, "did-navigate", (
			_event: ElectronEvent,
			url: string,
		) => {
			const normalized = normalizeBrowserViewUrl(url);
			const navigation = this.navigationForLoadedUrl(target, normalized);
			if (navigation) target.navigation = navigation;
			target.url = navigation?.requestedUrlFor(normalized) ?? normalized;
			this.emitState(target);
		});
		this.on(contents, target, "page-title-updated", () =>
			this.emitState(target));
		this.on(
			contents,
			target,
			"did-fail-load",
			(
				_event: ElectronEvent,
				errorCode: number,
				errorDescription: string,
				validatedURL: string,
				isMainFrame: boolean,
			) => {
				if (!isMainFrame) return;
				this.emit({
					type: "loadFailed",
					targetId: target.id,
					url: this.requestedUrlFor(target, validatedURL),
					errorCode,
					errorDescription,
				});
				this.emitState(target);
			},
		);
		this.on(contents, target, "render-process-gone", (
			_event: ElectronEvent,
			details: Electron.RenderProcessGoneDetails,
		) => {
			this.emit({
				type: "renderProcessGone",
				targetId: target.id,
				reason: details.reason,
			});
		});
		this.on(contents, target, "will-navigate", (
			event: ElectronEvent,
			url: string,
		) =>
			this.validateNavigation(target, event, url));
		this.on(contents, target, "will-redirect", (
			event: ElectronEvent,
			url: string,
		) =>
			this.validateNavigation(target, event, url));
		this.on(contents, target, "will-attach-webview", (
			event: ElectronEvent,
		) =>
			event.preventDefault());
		this.on(contents, target, "destroyed", () =>
			this.releaseTarget(target, false));
	}

	private validateNavigation(target: BrowserTarget, event: ElectronEvent, url: string): void {
		let normalized: string;
		try {
			normalized = normalizeBrowserViewUrl(url);
		} catch {
			event.preventDefault();
			return;
		}
		if (this.navigationForLoadedUrl(target, normalized)) return;
		event.preventDefault();
		const requestedUrl = this.requestedUrlFor(target, normalized);
		void this.queueNavigation(target, requestedUrl).catch(error => {
			if (!this.targets.has(target.id)) return;
			this.emit({
				type: "loadFailed",
				targetId: target.id,
				url: requestedUrl,
				errorCode: -2,
				errorDescription: error instanceof Error ? error.message : "Browser navigation resolution failed",
			});
			this.emitState(target);
		});
	}

	private queueNavigation(target: BrowserTarget, requestedUrl: string): Promise<void> {
		const operation = target.navigationTurn.then(() => this.navigateTarget(target, requestedUrl));
		target.navigationTurn = operation.catch(() => {});
		return operation;
	}

	private async navigateTarget(target: BrowserTarget, requestedUrl: string): Promise<void> {
		if (!this.targets.has(target.id) || target.cancellation.signal.aborted) throw new Error("BrowserTargetUnavailable");
		let navigation = this.reusableNavigationForRequestedUrl(target, requestedUrl);
		const created = navigation === undefined;
		if (!navigation) navigation = await this.navigationResolver.resolve(requestedUrl, target.cancellation.signal);
		if (!this.targets.has(target.id) || target.cancellation.signal.aborted) {
			if (created) navigation.release();
			throw new Error("BrowserTargetUnavailable");
		}
		if (created) target.navigations.add(navigation);
		target.pendingNavigation = navigation;
		try {
			await target.view.webContents.loadURL(navigation.loadUrlFor(requestedUrl));
			if (!this.targets.has(target.id) || target.cancellation.signal.aborted) throw new Error("BrowserTargetUnavailable");
			target.navigation = navigation;
			const loadedUrl = target.view.webContents.getURL() || navigation.loadUrlFor(requestedUrl);
			target.url = navigation.requestedUrlFor(loadedUrl);
		} catch (error) {
			if (created && this.targets.has(target.id) && target.navigations.delete(navigation)) navigation.release();
			throw error;
		} finally {
			if (target.pendingNavigation === navigation) target.pendingNavigation = undefined;
		}
	}

	private reusableNavigationForRequestedUrl(target: BrowserTarget, url: string): BrowserViewNavigation | undefined {
		if (target.navigation.isReusable() && target.navigation.ownsRequestedUrl(url)) return target.navigation;
		return [...target.navigations].find(navigation => navigation.isReusable() && navigation.ownsRequestedUrl(url));
	}

	private navigationForLoadedUrl(target: BrowserTarget, url: string): BrowserViewNavigation | undefined {
		if (target.pendingNavigation?.ownsLoadedUrl(url)) return target.pendingNavigation;
		if (target.navigation.ownsLoadedUrl(url)) return target.navigation;
		return [...target.navigations].find(navigation => navigation.ownsLoadedUrl(url));
	}

	private requestedUrlFor(target: BrowserTarget, loadedUrl: string): string {
		let normalized: string;
		try {
			normalized = normalizeBrowserViewUrl(loadedUrl);
		} catch {
			return loadedUrl;
		}
		return this.navigationForLoadedUrl(target, normalized)?.requestedUrlFor(normalized) ?? normalized;
	}

	private on(
		contents: WebContents,
		target: BrowserTarget,
		event: string,
		listener: (...args: any[]) => void,
	): void {
		const emitter = contents as unknown as EventEmitter;
		emitter.on(event, listener);
		target.disposables.use(toDisposable(() => emitter.removeListener(event, listener)));
	}

	private state(target: BrowserTarget): IBrowserViewState {
		const contents = target.view.webContents;
		if (contents.isDestroyed()) {
			throw new Error("BrowserTargetUnavailable");
		}
		const history = contents.navigationHistory;
		return {
			targetId: target.id,
			url: contents.getURL() ? this.requestedUrlFor(target, contents.getURL()) : target.url,
			title: contents.getTitle(),
			loading: contents.isLoading(),
			canGoBack: history.canGoBack(),
			canGoForward: history.canGoForward(),
			visible: target.visible,
		};
	}

	private target(targetId: string): BrowserTarget {
		const target = this.targets.get(targetId);
		if (!target || target.view.webContents.isDestroyed()) {
			throw new Error("BrowserTargetUnavailable");
		}
		return target;
	}

	private emitState(target: BrowserTarget): void {
		if (!this.targets.has(target.id)) return;
		this.emit({ type: "stateChanged", state: this.state(target) });
	}

	private emit(event: BrowserViewEvent): void {
		if (!this.disposing) this.emitEvent(event);
	}

	private releaseTarget(target: BrowserTarget, closeContents: boolean): void {
		if (!this.targets.delete(target.id)) return;
		target.cancellation.abort();
		this.registry.unregister(target.id);
		target.disposables.dispose();
		for (const navigation of target.navigations) navigation.release();
		target.navigations.clear();
		if (!this.window.isDestroyed()) {
			this.window.contentView.removeChildView(target.view);
		}
		if (closeContents && !target.view.webContents.isDestroyed()) {
			target.view.webContents.close();
		}
		this.emit({ type: "closed", targetId: target.id });
	}
}
