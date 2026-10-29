import type { IPermissionCategoryState } from '../common/browserPermissions.js';
import type { BrowserWindow, WebContentsView, Session, ContextMenuParams } from 'electron/main';
import { addAbortListener } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { createServiceIdentifier, IInstantiationService } from '../../instantiation/common/instantiation.js';
import {
	BrowserViewStorageScope,
	type IBrowserViewService,
	type BrowserViewEvent,
	type IBrowserViewBounds,
	type IBrowserViewCreateOptions,
	type IBrowserViewInfo,
	normalizeBrowserViewUrl,
} from '../common/browserView.js';
import { BrowserView } from './browserView.js';
import { BrowserSession } from './browserSession.js';
import type { SshPortForwardingService } from '../../remote/electron-main/sshPortForwardingService.js';
import type { ISerializedBrowserHistoryEntriesSnapshot } from '../common/browserHistory.js';
import { BrowserSessionHistory } from './browserSessionHistory.js';
import type {
	IBrowserViewWindowConfiguration,
	IBrowserElementSelectionOptions,
	IBrowserElementCommentsUpdate,
	IBrowserViewCaptureScreenshotOptions,
	IBrowserViewFindInPageOptions,
} from '../common/browserView.js';
import type { IBrowserDeviceProfile } from '../common/browserView.js';
import type { ElectronContextMenu } from '../../../base/parts/contextmenu/electron-main/contextmenu.js';
import type { NativeContextMenuItem } from '../../../base/parts/contextmenu/common/contextmenu.js';
import { IClipboardService } from '../../clipboard/common/clipboardService.js';
import { ILogService } from '../../log/common/log.js';
import { localize } from '../../../nls.js';
import { browserZoomFactors, browserZoomDefaultIndex } from '../common/browserView.js';

export const IBrowserViewMainService = createServiceIdentifier<IBrowserViewMainService>('browserViewMainService');
export interface IBrowserViewMainService extends IBrowserViewService {
	tryGetBrowserView(id: string): BrowserView | undefined;
	createTarget(
		url: string,
		sessionId: string,
		signal: AbortSignal,
		browserContextId?: string,
		canvas?: IBrowserViewCreateOptions['canvas'],
	): Promise<BrowserView>;
	createBrowserContext(threadId: string): string;
	disposeBrowserContext(contextId: string, threadId: string): Promise<void>;
	validateAgentAccess(id: string, sessionId: string): BrowserView;
	agentAccessSignal(id: string, threadId: string): AbortSignal;
	revokeSharing(): void;
	cancelPermissionRequests(): void;
}
export interface BrowserViewMainServiceOptions {
	readonly window: BrowserWindow;
	readonly getWorkspaceId: () => string;
	readonly createSession: (partition: string) => Session;
	readonly createView: (session: Session) => WebContentsView;
	readonly getRemoteNetwork: () =>
		{ readonly authority: string; readonly tunnels: SshPortForwardingService } | undefined;
	readonly contextMenu: ElectronContextMenu;
	readonly getNlsMessages: () => Readonly<Record<string, string>>;
}
/** The window manager is the sole table of live pages; each page owns its own disposal. */
export class BrowserViewMainService extends Disposable implements IBrowserViewMainService {
	public async setContentVisibility(
		id: string,
		rule: import('../common/browserView.js').IBrowserContentVisibilityRule | undefined,
	): Promise<void> {
		this.target(id).setContentVisibility(rule);
	}
	public async setPermissions(
		id: string,
		origin: string,
		grants: readonly IPermissionCategoryState[],
	): Promise<void> {
		const view = this.target(id);
		view.session.permissions.setPermissions(id, origin, grants);
	}
	private preloadConfiguration: IBrowserViewWindowConfiguration | undefined;
	public async updateWindowConfiguration(
		windowId: number,
		configuration: IBrowserViewWindowConfiguration,
	): Promise<void> {
		if (windowId !== this.options.window.id) {
			throw new Error('BrowserWindowAccessDenied');
		}
		this.preloadConfiguration = configuration;
		for (const [, view] of this.targets) {
			view.configurePreload(configuration);
		}
	}
	public async getConsoleLogs(id: string): Promise<string> {
		return this.target(id).getConsoleLogs();
	}
	public getSelectedText(id: string): Promise<string> {
		return this.target(id).getSelectedText();
	}
	public getAccessibilityTree(id: string): Promise<string> {
		return this.target(id).getAccessibilityTree();
	}
	public async findInPage(id: string, text: string, options?: IBrowserViewFindInPageOptions): Promise<void> {
		this.target(id).findInPage(text, options);
	}
	public async stopFindInPage(id: string, keepSelection?: boolean): Promise<void> {
		this.target(id).stopFindInPage(keepSelection);
	}
	public async toggleElementSelection(
		id: string,
		enabled?: boolean,
		options?: IBrowserElementSelectionOptions,
	): Promise<void> {
		this.target(id).toggleElementSelection(enabled, options);
	}
	public async setElementComments(id: string, update: IBrowserElementCommentsUpdate): Promise<void> {
		this.target(id).setElementComments(update);
	}
	public async toggleAreaSelection(id: string, enabled?: boolean): Promise<void> {
		this.target(id).toggleAreaSelection(enabled);
	}
	public captureScreenshot(id: string, options?: IBrowserViewCaptureScreenshotOptions) {
		return this.target(id).captureScreenshot(options);
	}
	private readonly targets = this._register(new DisposableMap<string, BrowserView>());
	private readonly events = this._register(new Emitter<BrowserViewEvent>());
	readonly onDidEvent = this.events.event;
	private readonly cancellation = new AbortController();
	private readonly creations = new Map<string, Promise<BrowserView>>();
	private readonly audiences = new Map<string, readonly string[]>();
	private readonly grants = new Map<string, Map<string, AbortController>>();
	private readonly histories = new Map<BrowserSession, BrowserSessionHistory>();
	private readonly contexts = new Map<
		string,
		{ readonly threadId: string; readonly affinity: string; readonly session: BrowserSession }
	>();
	private contextMenuOwner: BrowserView | undefined;
	constructor(
		private readonly options: BrowserViewMainServiceOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(toDisposable(() => this.cancellation.abort(new Error('BrowserCapabilityUnavailable'))));
	}
	private async showContextMenu(view: BrowserView, params: ContextMenuParams): Promise<void> {
		if (
			this.contextMenuOwner ||
			view.signal.aborted ||
			view.webContents.isDestroyed() ||
			!params.frame ||
			params.frame.detached
		) {
			return;
		}
		const contents = view.webContents;
		const items: NativeContextMenuItem[] = [];
		const actions = new Map<string, () => void | Promise<void>>();
		// Main follows the client's current language pack, including changes while the window is open.
		const text = (key: string, fallback: string): string => this.options.getNlsMessages()[key] ?? fallback;
		const add = (
			id: string,
			label: string,
			run: () => void | Promise<void>,
			enabled = true,
			target = items,
		): void => {
			target.push({ type: 'action', id, label, enabled });
			if (enabled) {
				actions.set(id, run);
			}
		};
		const separate = (): void => {
			if (items.length) {
				items.push({ type: 'separator' });
			}
		};
		const flags = params.editFlags;
		if (params.isEditable) {
			add(
				'undo',
				text(
					'browser.context.undo',
					localize({ bundle: 'ash.workbench', key: 'browser.context.undo' }, 'Undo'),
				),
				() => contents.undo(),
				flags.canUndo,
			);
			add(
				'redo',
				text(
					'browser.context.redo',
					localize({ bundle: 'ash.workbench', key: 'browser.context.redo' }, 'Redo'),
				),
				() => contents.redo(),
				flags.canRedo,
			);
			separate();
			add(
				'cut',
				text('browser.context.cut', localize({ bundle: 'ash.workbench', key: 'browser.context.cut' }, 'Cut')),
				() => contents.cut(),
				flags.canCut,
			);
		}
		if (params.isEditable || params.selectionText) {
			add(
				'copy',
				text(
					'browser.context.copy',
					localize({ bundle: 'ash.workbench', key: 'browser.context.copy' }, 'Copy'),
				),
				() => contents.copy(),
				flags.canCopy,
			);
		}
		if (params.isEditable) {
			add(
				'paste',
				text(
					'browser.context.paste',
					localize({ bundle: 'ash.workbench', key: 'browser.context.paste' }, 'Paste'),
				),
				() => contents.paste(),
				flags.canPaste,
			);
			add(
				'pastePlain',
				text(
					'browser.context.pastePlain',
					localize({ bundle: 'ash.workbench', key: 'browser.context.pastePlain' }, 'Paste as plain text'),
				),
				() => contents.pasteAndMatchStyle(),
				flags.canPaste,
			);
		}
		if (params.linkURL) {
			separate();
			let link: string | undefined;
			try {
				link = normalizeBrowserViewUrl(params.linkURL);
			} catch {
				/* Unsupported schemes remain copyable text. */
			}
			add(
				'openLink',
				text(
					'browser.context.openLink',
					localize({ bundle: 'ash.workbench', key: 'browser.context.openLink' }, 'Open link in new tab'),
				),
				() => {
					this.events.fire({ type: 'openRequested', targetId: view.id, url: link! });
				},
				link !== undefined && view.getInfo().owner.type === 'user',
			);
			add(
				'copyLink',
				text(
					'browser.context.copyLink',
					localize({ bundle: 'ash.workbench', key: 'browser.context.copyLink' }, 'Copy link address'),
				),
				() => this.clipboard.writeText(params.linkURL),
			);
		}
		if (params.mediaType === 'image' || params.mediaType === 'canvas') {
			separate();
			add(
				'copyImage',
				text(
					'browser.context.copyImage',
					localize({ bundle: 'ash.workbench', key: 'browser.context.copyImage' }, 'Copy image'),
				),
				() => contents.copyImageAt(params.x, params.y),
				params.hasImageContents,
			);
			let downloadable = false;
			try {
				const source = new URL(params.srcURL);
				downloadable =
					!source.username &&
					!source.password &&
					(['https:', 'http:', 'blob:'].includes(source.protocol) ||
						(source.protocol === 'data:' && params.srcURL.startsWith('data:image/')));
			} catch {
				/* A canvas without an address can still be copied. */
			}
			add(
				'saveImage',
				text(
					'browser.context.saveImage',
					localize({ bundle: 'ash.workbench', key: 'browser.context.saveImage' }, 'Save image as…'),
				),
				() => contents.downloadURL(params.srcURL),
				downloadable && params.hasImageContents,
			);
		}
		separate();
		add(
			'selectAll',
			text(
				'browser.context.selectAll',
				localize({ bundle: 'ash.workbench', key: 'browser.context.selectAll' }, 'Select all'),
			),
			() => contents.selectAll(),
			flags.canSelectAll,
		);
		separate();
		add(
			'back',
			text('browser.back', localize({ bundle: 'ash.workbench', key: 'browser.back' }, 'Back')),
			() => view.goBack(),
			contents.navigationHistory.canGoBack(),
		);
		add(
			'forward',
			text('browser.forward', localize({ bundle: 'ash.workbench', key: 'browser.forward' }, 'Forward')),
			() => view.goForward(),
			contents.navigationHistory.canGoForward(),
		);
		add(
			'reload',
			text('browser.reload', localize({ bundle: 'ash.workbench', key: 'browser.reload' }, 'Reload')),
			() => view.reload(),
		);
		const zoom = view.getState().browserZoomIndex ?? browserZoomDefaultIndex;
		const zoomItems: NativeContextMenuItem[] = [];
		add(
			'zoomIn',
			text(
				'browser.context.zoomIn',
				localize({ bundle: 'ash.workbench', key: 'browser.context.zoomIn' }, 'Zoom in'),
			),
			() => view.setBrowserZoomIndex(zoom + 1),
			zoom < browserZoomFactors.length - 1,
			zoomItems,
		);
		add(
			'zoomOut',
			text(
				'browser.context.zoomOut',
				localize({ bundle: 'ash.workbench', key: 'browser.context.zoomOut' }, 'Zoom out'),
			),
			() => view.setBrowserZoomIndex(zoom - 1),
			zoom > 0,
			zoomItems,
		);
		add(
			'resetZoom',
			text(
				'browser.context.resetZoom',
				localize({ bundle: 'ash.workbench', key: 'browser.context.resetZoom' }, 'Reset zoom'),
			),
			() => view.setBrowserZoomIndex(browserZoomDefaultIndex),
			true,
			zoomItems,
		);
		items.push({
			type: 'submenu',
			label: text('browser.zoom', localize({ bundle: 'ash.workbench', key: 'browser.zoom' }, 'Page zoom')),
			enabled: true,
			items: zoomItems,
		});
		const bounds = view.view.getBounds();
		const windowZoom = this.options.window.webContents.getZoomFactor();
		let cancelled = false;
		const cancel = (): void => {
			cancelled = true;
			this.options.contextMenu.close();
		};
		this.contextMenuOwner = view;
		contents.on('did-start-navigation', cancel);
		using cancellation = addAbortListener(view.signal, cancel);
		try {
			// Chromium reports view-local DIP; the shared menu API accepts Workbench CSS coordinates.
			const { selectedId } = await this.options.contextMenu.popup({
				items,
				x: (bounds.x + params.x) / windowZoom,
				y: (bounds.y + params.y) / windowZoom,
			});
			if (
				!cancelled &&
				!view.signal.aborted &&
				!contents.isDestroyed() &&
				params.frame &&
				!params.frame.detached
			) {
				view.focus();
				if (selectedId) {
					await actions.get(selectedId)?.();
				}
			}
		} finally {
			contents.removeListener('did-start-navigation', cancel);
			this.contextMenuOwner = undefined;
		}
	}
	tryGetBrowserView(id: string): BrowserView | undefined {
		const view = this.targets.get(id);
		return view && !view.webContents.isDestroyed() && !view.signal.aborted ? view : undefined;
	}
	private target(id: string): BrowserView {
		const view = this.tryGetBrowserView(id);
		if (!view) throw new Error('BrowserTargetUnavailable');
		return view;
	}
	public async getBrowserViews(): Promise<readonly IBrowserViewInfo[]> {
		return [...this.targets].map(([, view]) => view.getInfo());
	}
	public async getOrCreateBrowserView(id: string, options: IBrowserViewCreateOptions): Promise<IBrowserViewInfo> {
		return (await this.getOrCreate(id, options, this.cancellation.signal)).getInfo();
	}
	public createBrowserContext(threadId: string): string {
		this.assertNotDisposed();
		if (this.contexts.size >= 128) {
			throw new Error('BrowserContextCapacityExceeded');
		}
		const affinity = JSON.stringify([threadId, randomUUID()]);
		const identity = this.sessionIdentity({ scope: BrowserViewStorageScope.Agent, affinity });
		const session = BrowserSession.getOrCreate(
			identity,
			BrowserViewStorageScope.Agent,
			this.options.createSession('ash-browser-' + identity),
		);
		this.contexts.set(identity, { threadId, affinity, session });
		return identity;
	}
	public async disposeBrowserContext(contextId: string, threadId: string): Promise<void> {
		const context = this.contexts.get(contextId);
		if (!context || context.threadId !== threadId) {
			throw new Error('BrowserContextAccessDenied');
		}
		this.contexts.delete(contextId);
		for (const [, view] of this.targets) {
			if (view.session.id === contextId) {
				view.dispose();
			}
		}
		await context.session.electronSession.closeAllConnections();
		await context.session.electronSession.clearStorageData();
		await context.session.electronSession.clearCache();
	}
	public createTarget(
		url: string,
		sessionId: string,
		signal: AbortSignal,
		browserContextId?: string,
		canvas?: IBrowserViewCreateOptions['canvas'],
	): Promise<BrowserView> {
		const pages = [...this.targets].map(([, view]) => view);
		const owned = pages.filter(view => {
			const owner = view.getInfo().owner;
			return owner.type === 'agent' && owner.sessionId === sessionId;
		}).length;
		if (owned + this.creations.size >= 256) {
			throw new Error('BrowserTargetCapacityExceeded');
		}
		const context = browserContextId === undefined ? undefined : this.contexts.get(browserContextId);
		const existing =
			browserContextId === undefined
				? undefined
				: pages
						.find(view => {
							const owner = view.getInfo().owner;
							return (
								view.session.id === browserContextId &&
								owner.type === 'agent' &&
								owner.sessionId === sessionId
							);
						})
						?.getInfo().session;
		const affinity =
			context?.threadId === sessionId
				? context.affinity
				: existing?.scope === BrowserViewStorageScope.Agent
					? existing.affinity
					: undefined;
		if (browserContextId !== undefined && affinity === undefined) {
			throw new Error('BrowserContextAccessDenied');
		}
		return this.getOrCreate(
			'browser_target_' + randomUUID(),
			{
				initialUrl: url,
				owner: { type: 'agent', sessionId },
				session: { scope: BrowserViewStorageScope.Agent, affinity: affinity ?? sessionId },
				...(canvas ? { canvas } : {}),
			},
			signal,
		);
	}
	private sessionIdentity(storage: IBrowserViewCreateOptions['session'], pageId?: string): string {
		let identity: string;
		switch (storage.scope) {
			case BrowserViewStorageScope.Global:
				identity = 'global';
				break;
			case BrowserViewStorageScope.Workspace:
				identity = 'workspace:' + this.options.getWorkspaceId();
				break;
			case BrowserViewStorageScope.Ephemeral:
				identity = 'ephemeral:' + pageId;
				break;
			case BrowserViewStorageScope.Agent:
				identity = JSON.stringify(['agent', this.options.window.id, storage.affinity]);
				break;
		}
		const remote = this.options.getRemoteNetwork();
		return createHash('sha256')
			.update(remote ? JSON.stringify([identity, remote.authority]) : identity)
			.digest('hex');
	}
	public validateAgentAccess(id: string, sessionId: string): BrowserView {
		const view = this.target(id);
		const owner = view.getInfo().owner;
		if (
			!(owner.type === 'agent' && owner.sessionId === sessionId) &&
			!this.audiences.get(id)?.includes(sessionId)
		) {
			throw new Error('BrowserTargetAccessDenied');
		}
		return view;
	}
	public async getSharing(id: string): Promise<readonly string[]> {
		this.target(id);
		return this.audiences.get(id) ?? [];
	}
	public async setSharing(id: string, threadIds: readonly string[]): Promise<void> {
		if (this.target(id).getInfo().owner.type !== 'user') {
			throw new Error('Only user pages can be shared');
		}
		const audience = [...new Set(threadIds)];
		for (const [thread, controller] of this.grants.get(id) ?? []) {
			if (!audience.includes(thread)) {
				controller.abort(new Error('BrowserSharingRevoked'));
				this.grants.get(id)!.delete(thread);
			}
		}
		this.audiences.set(id, audience);
		this.events.fire({ type: 'sharingChanged', targetId: id, threadIds: audience });
	}
	public agentAccessSignal(id: string, threadId: string): AbortSignal {
		const view = this.validateAgentAccess(id, threadId);
		if (view.getInfo().owner.type === 'agent') {
			return view.signal;
		}
		let grants = this.grants.get(id);
		if (!grants) {
			grants = new Map();
			this.grants.set(id, grants);
		}
		let grant = grants.get(threadId);
		if (!grant) {
			grant = new AbortController();
			grants.set(threadId, grant);
		}
		return grant.signal;
	}
	public revokeSharing(): void {
		for (const id of this.audiences.keys()) {
			void this.setSharing(id, []);
		}
	}
	public cancelPermissionRequests(): void {
		for (const [id, view] of this.targets) view.session.permissions.cancelRequests(id);
	}
	private getOrCreate(id: string, options: IBrowserViewCreateOptions, signal: AbortSignal): Promise<BrowserView> {
		const view = this.tryGetBrowserView(id);
		if (view) {
			return Promise.resolve(view);
		}
		const pending = this.creations.get(id);
		if (pending) return pending;
		const creation = this.create(id, options, signal);
		this.creations.set(id, creation);
		void creation.then(
			() => this.creations.delete(id),
			() => this.creations.delete(id),
		);
		return creation;
	}
	private async create(
		id: string,
		options: IBrowserViewCreateOptions,
		requestSignal: AbortSignal,
	): Promise<BrowserView> {
		const signal = AbortSignal.any([requestSignal, this.cancellation.signal]);
		signal.throwIfAborted();
		const initialUrl = normalizeBrowserViewUrl(options.initialUrl);
		if (options.owner.type === 'agent' && new URL(initialUrl).protocol === 'file:') {
			throw new Error('BrowserLocalFileAccessDenied');
		}
		const remoteNetwork = this.options.getRemoteNetwork();
		let network: IDisposable | undefined;
		let view: BrowserView;
		try {
			const storage = options.session;
			const contextId = this.sessionIdentity(storage, id);
			const persistent =
				storage.scope === BrowserViewStorageScope.Global || storage.scope === BrowserViewStorageScope.Workspace;
			const electronSession = this.options.createSession(
				(persistent ? 'persist:' : '') + 'ash-browser-' + contextId,
			);
			const session = BrowserSession.getOrCreate(contextId, storage.scope, electronSession);
			network = remoteNetwork ? await session.acquireRemote(remoteNetwork.tunnels, signal) : undefined;
			signal.throwIfAborted();
			let history = this.histories.get(session);
			if (!history) {
				const lease = await session.acquireHistory(() =>
					this.instantiationService.createInstance(BrowserSessionHistory, session),
				);
				try {
					signal.throwIfAborted();
					this._register(lease);
				} catch (error) {
					lease.dispose();
					throw error;
				}
				history = lease.history;
				this.histories.set(session, history);
			}
			view = this.instantiationService.createInstance(BrowserView, {
				remoteAuthority: remoteNetwork?.authority,
				id,
				window: this.options.window,
				view: this.options.createView(electronSession),
				initialUrl,
				network,
				creation: options,
				session,
				history,
				openContextMenu: (target: BrowserView, params: ContextMenuParams) => {
					void this.showContextMenu(target, params).catch(error =>
						this.log.error('Could not open browser context menu', error),
					);
				},
				emitEvent: (event: BrowserViewEvent) => {
					if (event.type === 'closed') {
						this.targets.deleteAndLeak(id);
						for (const controller of this.grants.get(id)?.values() ?? []) {
							controller.abort();
						}
						this.grants.delete(id);
						this.audiences.delete(id);
					}
					if (!this.isDisposed) this.events.fire(event);
				},
			});
		} catch (error) {
			network?.dispose();
			throw error;
		}
		this.targets.set(id, view);
		try {
			if (this.preloadConfiguration) {
				view.configurePreload(this.preloadConfiguration);
			}
			view.initialize();
			return view;
		} catch (error) {
			this.targets.deleteAndDispose(id);
			throw error;
		}
	}
	async getState(id: string) {
		return this.target(id).getState();
	}
	async respondToFileRequest(id: string, requestId: string, data: string | null) {
		this.target(id).respondToFileRequest(requestId, data);
	}
	async respondToAuthentication(
		id: string,
		requestId: string,
		credentials: { readonly username: string; readonly password: string; readonly remember: boolean } | null,
	) {
		await this.target(id).respondToAuthentication(requestId, credentials);
	}
	async respondToPasswordSave(id: string, requestId: string, save: boolean) {
		await this.target(id).respondToPasswordSave(requestId, save);
	}
	async respondToPasswordFill(id: string, requestId: string, accountId: string | null) {
		await this.target(id).respondToPasswordFill(requestId, accountId);
	}
	async setBrowserZoomIndex(id: string, index: number) {
		this.target(id).setBrowserZoomIndex(index);
	}
	async toggleDevTools(id: string) {
		this.target(id).toggleDevTools();
	}
	async setDeviceEmulation(id: string, device: IBrowserDeviceProfile | undefined) {
		this.target(id).setDeviceEmulation(device);
	}
	async clearStorage(id: string) {
		const view = this.target(id);
		const session = view.session;
		session.cancelAuthentication();
		await view.clearAuthentication();
		await session.electronSession.clearStorageData();
		await session.electronSession.clearCache();
		session.permissions.clear();
	}
	public async getBrowserHistory(id: string): Promise<ISerializedBrowserHistoryEntriesSnapshot> {
		return this.histories.get(this.target(id).session)!.entries.serialize();
	}
	public async deleteBrowserHistory(id: string, entryIds?: readonly number[]): Promise<void> {
		await this.histories.get(this.target(id).session)!.delete(entryIds);
	}
	public async respondToPermission(id: string, requestId: string, allowed: boolean): Promise<void> {
		this.target(id).session.permissions.respond(id, requestId, allowed);
	}
	public async clearPermissions(id: string): Promise<void> {
		this.target(id).session.permissions.clear();
	}
	public async cancelDownloads(id: string): Promise<void> {
		this.target(id).session.permissions.cancelDownloads(id);
	}
	async layout(id: string, bounds: IBrowserViewBounds) {
		this.target(id).layout(bounds);
	}
	async setVisible(id: string, visible: boolean) {
		this.target(id).setVisible(visible);
	}
	loadURL(id: string, url: string, signal?: AbortSignal) {
		return this.target(id).loadURL(url, signal);
	}
	goBack(id: string) {
		return this.target(id).goBack();
	}
	goForward(id: string) {
		return this.target(id).goForward();
	}
	reload(id: string, hard?: boolean) {
		return this.target(id).reload(hard);
	}
	async stop(id: string) {
		this.target(id).stop();
	}
	async focus(id: string) {
		this.target(id).focus();
	}
	async destroyBrowserView(id: string) {
		this.target(id);
		this.targets.deleteAndDispose(id);
	}
}
