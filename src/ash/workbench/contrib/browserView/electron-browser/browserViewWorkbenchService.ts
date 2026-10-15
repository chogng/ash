import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { extUri } from '../../../../base/common/resources.js';
import { IBrowserViewService, type BrowserViewEvent, type IBrowserViewCreateOptions, type IBrowserViewInfo } from '../../../../platform/browserView/common/browserView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { IEditorService, type EditorOpenOptions } from '../../../services/editor/common/editorService.js';
import { BrowserEditorInput, type IBrowserEditorInputData } from '../common/browserEditorInput.js';
import { BrowserViewModel, type IBrowserViewContextualFilter, type IBrowserViewFilterContext, type IBrowserViewOpenHandler, type IBrowserViewPresentationOptions, type IBrowserViewWorkbenchService, type IBrowserViewWorkbenchCreateOptions } from '../common/browserView.js';
import { IDialogsModel, type IDialogHandle } from '../../../common/dialogs.js';
import { DialogResult } from '../../../../platform/dialogs/common/dialogs.js';
import { localize } from '../../../../nls.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService, getWorkspaceRemoteAuthority, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { logBrowserOpen, type IntegratedBrowserOpenSource } from '../../../../platform/browserView/common/browserViewTelemetry.js';

/** Owns renderer inputs and reconnects them to pages which can outlive a renderer reload. */
export class BrowserViewWorkbenchService extends Disposable implements IBrowserViewWorkbenchService {
	private readonly inputs = this._register(new DisposableMap<string, BrowserEditorInput>());
	private readonly inputListeners = this._register(new DisposableMap<string, IDisposable>());
	private readonly changes = this._register(new Emitter<void>());
	public readonly onDidChangeBrowserViews = this.changes.event;
	private readonly filters = new Set<IBrowserViewContextualFilter>();
	private readonly openHandlers = new Set<IBrowserViewOpenHandler>();
	private readonly windowBrowserViews = new Map<string, IBrowserViewPresentationOptions>();
	private readonly retiringInputs = this._register(new DisposableStore());
	private readonly closingInputs = new Map<string, Promise<void>>();
	private readonly initialEvents: BrowserViewEvent[] = [];
	private initialized = false;
	private initialization: Promise<void> | undefined;
	private readonly permissionDialogs = new Map<string, IDialogHandle>();

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService,
		@IFileService private readonly files: IFileService,
		@IBrowserViewService private readonly service: IBrowserViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editors: IEditorService,
		@IEditorPart private readonly editorPart: IEditorPart,
		@IDialogsModel private readonly dialogs: IDialogsModel,
		@ITelemetryService private readonly telemetry: ITelemetryService,
	) {
		super();
		this._register(service.onDidEvent(event => {
			if (event.type === 'fileRequested') { this.acceptEvent(event); }
			else if (!this.initialized) { this.initialEvents.push(event); }
			else { this.acceptEvent(event); }
		}));
		this._register(editorPart.onDidChangeEditors(event => {
			if (event.kind !== 'groupChanged' || event.event.kind !== 'editorClosed' || event.event.reason === 'move' || event.event.reason === 'reset') { return; }
			const input = event.event.editor.input;
			if (!(input instanceof BrowserEditorInput)) { return; }
			const id = BrowserViewUri.getId(input.resource)!;
			if (this.inputs.get(id) !== input) { return; }
			if (this.isWindowBrowserView(id)) { return; }
			if (editorPart.groups.some(group => group.inputs.some(candidate => extUri.isEqual(candidate.resource, input.resource)))) { return; }
			void service.destroyBrowserView(id).catch(error => console.error('Failed to close browser page', error));
		}));
	}

	public initialize(): Promise<void> {
		this.assertNotDisposed();
		this.initialization ??= this.readInitialViews().catch(error => {
			this.initialization = undefined;
			throw error;
		});
		return this.initialization;
	}

	private async readInitialViews(): Promise<void> {
		const views = await this.service.getBrowserViews();
		this.assertNotDisposed();
		for (const info of views) { this.acceptInfo(info); }
		// Subscribe before the snapshot and replay everything received while it was in flight.
		this.initialized = true;
		for (const event of this.initialEvents.splice(0)) { this.acceptEvent(event); }
		// Restoration opens the known inputs after initialization; retire snapshot-era tabs first.
		await Promise.all(this.closingInputs.values());
		this.assertNotDisposed();
	}

	public getKnownBrowserViews(): ReadonlyMap<string, BrowserEditorInput> {
		return new Map(this.inputs);
	}

	public getContextualBrowserViews(context: IBrowserViewFilterContext = {}): Map<string, BrowserEditorInput> {
		return new Map([...this.inputs].filter(([, input]) => {
			if (this.isWindowBrowserView(input.id)) { return false; }
			const owner = input.model?.info.owner;
			if (context.sandboxSessionId !== undefined && (owner?.type !== 'agent' || owner.sessionId !== context.sandboxSessionId)) { return false; }
			return [...this.filters].every(filter => filter.include(input, context));
		}));
	}

	public registerContextualFilter(filter: IBrowserViewContextualFilter): IDisposable {
		this.assertNotDisposed();
		this.filters.add(filter);
		const listener = filter.onDidChange?.(() => this.changes.fire());
		this.changes.fire();
		return toDisposable(() => {
			listener?.dispose();
			if (this.filters.delete(filter)) { this.changes.fire(); }
		});
	}

	public registerOpenHandler(handler: IBrowserViewOpenHandler): IDisposable {
		this.assertNotDisposed();
		this.openHandlers.add(handler);
		return toDisposable(() => { this.openHandlers.delete(handler); });
	}

	public registerWindowBrowserView(id: string, presentation: IBrowserViewPresentationOptions = {}): IDisposable {
		this.assertNotDisposed();
		if (this.windowBrowserViews.has(id)) {
			throw new Error(`Browser page already has a window owner: ${id}`);
		}
		this.windowBrowserViews.set(id, presentation);
		this.changes.fire();
		return toDisposable(() => {
			if (this.windowBrowserViews.delete(id) && !this.isDisposed) {
				this.changes.fire();
			}
		});
	}

	public isWindowBrowserView(id: string): boolean {
		return this.windowBrowserViews.has(id);
	}

	public getBrowserViewPresentation(id: string): IBrowserViewPresentationOptions | undefined {
		return this.windowBrowserViews.get(id);
	}

	public getOrCreateLazy(data: IBrowserEditorInputData): BrowserEditorInput {
		this.assertNotDisposed();
		let input = this.inputs.get(data.id);
		if (!input) {
			input = this.instantiationService.createInstance(BrowserEditorInput, data);
			this.inputs.set(data.id, input);
			this.inputListeners.set(data.id, input.onDidResolveModel(() => this.changes.fire()));
			this.changes.fire();
		}
		return input;
	}

	public async createBrowserView(request: IBrowserViewWorkbenchCreateOptions, source?: IntegratedBrowserOpenSource): Promise<BrowserEditorInput> {
		await this.initialize();
		const options: IBrowserViewCreateOptions = { ...request, session: request.session ?? await this.defaultStorage(request.owner) };
		this.assertNotDisposed();
		const id = 'browser_target_' + crypto.randomUUID();
		// Reserve the input before creation: the IPC result and created event can arrive in either order.
		const input = this.getOrCreateLazy({ id, url: options.initialUrl, title: '', session: options.session });
		try {
			const info = await this.service.getOrCreateBrowserView(id, options);
			this.assertNotDisposed();
			if (this.inputs.get(id) !== input) { throw new Error('BrowserTargetUnavailable'); }
			if (!input.model) { input.model = this.instantiationService.createInstance(BrowserViewModel, info); }
			await this.openEditor(input);
			this.assertNotDisposed();
			if (this.inputs.get(id) !== input) { throw new Error('BrowserTargetUnavailable'); }
			logBrowserOpen(this.telemetry, source ?? (options.initialUrl === 'about:blank' ? 'commandWithoutUrl' : 'commandWithUrl'));
			return input;
		} catch (error) {
			if (this.inputs.get(id) === input) {
				this.inputListeners.deleteAndDispose(id);
				this.inputs.deleteAndDispose(id);
				this.changes.fire();
			}
			throw error;
		}
	}

	private async defaultStorage(owner: IBrowserViewCreateOptions['owner']): Promise<IBrowserViewCreateOptions['session']> {
		if (owner.type === 'agent') { throw new Error('Agent browser storage requires an explicit Thread'); }
		// Offline hosts cannot resolve backend capabilities; keep new pages isolated until trust is known.
		const trust = await this.trust.getWorkspaceTrustInfo().catch(() => undefined);
		if (!trust?.isTrusted) { return { scope: BrowserViewStorageScope.Ephemeral }; }
		const configured = this.configuration.getValue<string>('workbench.browser.dataStorage');
		const remote = getWorkspaceRemoteAuthority(this.workspace.getWorkspace());
		const scope = configured === 'default' ? (remote ? BrowserViewStorageScope.Workspace : BrowserViewStorageScope.Global) : configured;
		if (scope === BrowserViewStorageScope.Ephemeral || (scope === BrowserViewStorageScope.Workspace && this.workspace.getWorkbenchState() === WorkbenchState.EMPTY)) { return { scope: BrowserViewStorageScope.Ephemeral }; }
		// A remote connection cannot join local global cookies. Main also isolates its proxy partition.
		return { scope: scope === BrowserViewStorageScope.Global && !remote ? BrowserViewStorageScope.Global : BrowserViewStorageScope.Workspace };
	}

	private acceptInfo(info: IBrowserViewInfo): BrowserEditorInput {
		const input = this.getOrCreateLazy({ id: info.id, url: info.state.url, title: info.state.title, session: info.session });
		if (!input.model) { input.model = this.instantiationService.createInstance(BrowserViewModel, info); }
		return input;
	}

	private async openEditor(input: BrowserEditorInput, options: EditorOpenOptions = {}): Promise<void> {
		const id = BrowserViewUri.getId(input.resource)!;
		await this.closingInputs.get(id);
		if (this.isDisposed || this.inputs.get(id) !== input) { return; }
		if (this.isWindowBrowserView(id)) { return; }
		const owner = input.model?.info.owner ?? { type: 'user' as const };
		if (![...this.openHandlers].every(handler => handler.shouldOpenEditor(input, owner, options))) { return; }
		await this.editors.openEditor(input, { pinned: true, ...options });
	}

	private acceptEvent(event: BrowserViewEvent): void {
		if (event.type === 'fileRequested') {
			void (async () => {
				let data: string | null = null;
				try {
					const resource = URI.parse(event.url).with({ query: '', fragment: '' });
					if (resource.scheme !== 'file') { throw new Error('Invalid browser file resource'); }
					const content = await this.files.readFileBytes(resource);
					if (content.bytes.byteLength > 16 * 1024 * 1024) { throw new Error('Browser file is too large'); }
					data = encodeBase64(VSBuffer.wrap(new Uint8Array(content.bytes)));
				} finally {
					if (!this.isDisposed) { await this.service.respondToFileRequest(event.targetId, event.requestId, data); }
				}
			})().catch(error => console.error('Browser file read failed', error));
		} else if (event.type === 'permissionRequested') {
			const handle = this.dialogs.show({
				kind: 'confirmation',
				title: localize({ bundle: 'ash.workbench', key: 'browser.permissionTitle' }, 'Website permission'),
				message: localize({ bundle: 'ash.workbench', key: 'browser.permissionDescription' }, '{0} requests access to {1}.', event.origin, permissionLabel(event.permission)),
				primaryButton: localize({ bundle: 'ash.workbench', key: 'browser.allow' }, 'Allow'),
				cancelButton: localize({ bundle: 'ash.workbench', key: 'browser.deny' }, 'Deny'),
			});
			this.permissionDialogs.set(event.requestId, handle);
			void handle.result.then(async outcome => {
				if (!this.permissionDialogs.delete(event.requestId)) { return; }
				await this.service.respondToPermission(event.targetId, event.requestId, outcome.button === DialogResult.Primary);
			}).catch(error => console.error('Browser permission response failed', error));
		} else if (event.type === 'permissionRequestClosed') {
			const handle = this.permissionDialogs.get(event.requestId);
			this.permissionDialogs.delete(event.requestId);
			handle?.item.cancel();
		} else if (event.type === 'created') {
			const known = this.inputs.has(event.info.id);
			const input = this.acceptInfo(event.info);
			if (!known) {
				void this.openEditor(input).catch(error => console.error('Failed to open browser editor', error));
			}
		} else if (event.type === 'closed') {
			const input = this.inputs.deleteAndLeak(event.targetId);
			if (!input) { return; }
			this.inputListeners.deleteAndDispose(event.targetId);
			this.changes.fire();
			this.retiringInputs.add(input);
			// Finish broadcasting Main's close before detaching the model. A replacement must wait for the old tabs.
			const closing = Promise.resolve().then(async () => {
				if (this.isDisposed) { return; }
				for (const group of this.editorPart.groups) {
					if (group.inputs.includes(input)) { await group.closeEditor(input); }
				}
			}).finally(() => {
				this.retiringInputs.delete(input);
				input.dispose();
				if (this.closingInputs.get(event.targetId) === closing) { this.closingInputs.delete(event.targetId); }
			});
			this.closingInputs.set(event.targetId, closing);
			void closing.catch(error => console.error('Failed to close browser editor', error));
		} else if (event.type === 'openRequested') {
			void this.service.getBrowserViews().then(views => {
				const parent = views.find(view => view.id === event.targetId);
				if (!parent) { throw new Error('BrowserTargetUnavailable'); }
				return this.createBrowserView({ initialUrl: event.url, owner: parent.owner, session: parent.session }, 'browserLinkForeground');
			}).catch(error => console.error('Failed to open browser popup', error));
		}
	}
	protected override disposeCore(): void {
		for (const handle of this.permissionDialogs.values()) { handle.item.cancel(); }
		this.permissionDialogs.clear();
		this.filters.clear();
		this.openHandlers.clear();
		this.windowBrowserViews.clear();
		super.disposeCore();
	}
}

function permissionLabel(permission: string): string {
	if (permission.startsWith('media:')) { return localize({ bundle: 'ash.workbench', key: 'browser.media' }, 'camera and microphone'); }
	if (permission === 'geolocation') { return localize({ bundle: 'ash.workbench', key: 'browser.geolocation' }, 'location'); }
	if (permission === 'notifications') { return localize({ bundle: 'ash.workbench', key: 'browser.notifications' }, 'notifications'); }
	if (permission === 'fullscreen') { return localize({ bundle: 'ash.workbench', key: 'browser.fullscreen' }, 'full screen'); }
	return localize({ bundle: 'ash.workbench', key: 'browser.clipboard' }, 'clipboard');
}
