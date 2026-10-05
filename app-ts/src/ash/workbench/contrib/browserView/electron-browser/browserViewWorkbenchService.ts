import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { extUri } from '../../../../base/common/resources.js';
import { IBrowserViewService, type BrowserViewEvent, type IBrowserViewCreateOptions, type IBrowserViewInfo } from '../../../../platform/browserView/common/browserView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { BrowserEditorInput, type IBrowserEditorInputData } from '../common/browserEditorInput.js';
import { type IBrowserViewWorkbenchService } from '../common/browserView.js';
import { IDialogsModel, type IDialogHandle } from '../../../common/dialogs.js';
import { DialogResult } from '../../../../platform/dialogs/common/dialogs.js';
import { localize } from '../../../../nls.js';

/** Owns renderer inputs and reconnects them to pages which can outlive a renderer reload. */
export class BrowserViewWorkbenchService extends Disposable implements IBrowserViewWorkbenchService {
	private readonly inputs = this._register(new DisposableMap<string, BrowserEditorInput>());
	private readonly initialEvents: BrowserViewEvent[] = [];
	private initialized = false;
	private initialization: Promise<void> | undefined;
	private readonly permissionDialogs = new Map<string, IDialogHandle>();

	constructor(
		@IBrowserViewService private readonly service: IBrowserViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editors: IEditorService,
		@IEditorPart private readonly editorPart: IEditorPart,
		@IDialogsModel private readonly dialogs: IDialogsModel,
	) {
		super();
		this._register(service.onDidEvent(event => {
			if (!this.initialized) { this.initialEvents.push(event); }
			else { this.acceptEvent(event); }
		}));
		this._register(editorPart.onDidChangeEditors(event => {
			if (event.kind !== 'groupChanged' || event.event.kind !== 'editorClosed' || event.event.reason === 'move' || event.event.reason === 'reset') { return; }
			const input = event.event.editor.input;
			if (!(input instanceof BrowserEditorInput)) { return; }
			if (this.inputs.get(input.resource.path.slice(1)) !== input) { return; }
			if (editorPart.groups.some(group => group.inputs.some(candidate => extUri.isEqual(candidate.resource, input.resource)))) { return; }
			void service.destroyBrowserView(input.resource.path.slice(1)).catch(error => console.error('Failed to close browser page', error));
		}));
	}

	public initialize(): Promise<void> {
		this.initialization ??= this.readInitialViews();
		return this.initialization;
	}

	private async readInitialViews(): Promise<void> {
		const views = await this.service.getBrowserViews();
		this.assertNotDisposed();
		for (const info of views) { this.acceptInfo(info); }
		// Subscribe before the snapshot and replay everything received while it was in flight.
		this.initialized = true;
		for (const event of this.initialEvents.splice(0)) { this.acceptEvent(event); }
	}

	public getKnownBrowserViews(): ReadonlyMap<string, BrowserEditorInput> {
		return new Map(this.inputs);
	}

	public getOrCreateLazy(data: IBrowserEditorInputData): BrowserEditorInput {
		let input = this.inputs.get(data.id);
		if (!input) {
			input = this.instantiationService.createInstance(BrowserEditorInput, data);
			this.inputs.set(data.id, input);
		}
		return input;
	}

	public async createBrowserView(options: IBrowserViewCreateOptions): Promise<BrowserEditorInput> {
		await this.initialize();
		const id = 'browser_target_' + crypto.randomUUID();
		// Reserve the input before creation: the IPC result and created event can arrive in either order.
		const input = this.getOrCreateLazy({ id, url: options.initialUrl, title: '', session: options.session });
		try {
			await this.service.getOrCreateBrowserView(id, options);
			await this.editors.openEditor(input, { pinned: true });
			return input;
		} catch (error) {
			this.inputs.deleteAndDispose(id);
			throw error;
		}
	}

	private acceptInfo(info: IBrowserViewInfo): BrowserEditorInput {
		return this.getOrCreateLazy({ id: info.id, url: info.state.url, title: info.state.title, session: info.session });
	}

	private acceptEvent(event: BrowserViewEvent): void {
		if (event.type === 'permissionRequested') {
			const handle = this.dialogs.show({ kind: 'confirmation',
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
				void this.editors.openEditor(input, { pinned: true }).catch(error => console.error('Failed to open browser editor', error));
			}
		} else if (event.type === 'closed') {
			const input = this.inputs.get(event.targetId);
			if (!input) { return; }
			this.inputs.deleteAndDispose(event.targetId);
			for (const group of this.editorPart.groups) {
				for (const candidate of group.inputs) {
					if (extUri.isEqual(candidate.resource, input.resource)) {
						void group.closeEditor(candidate).catch(error => console.error('Failed to close browser editor', error));
					}
				}
			}
		} else if (event.type === 'openRequested') {
			void this.service.getBrowserViews().then(views => {
				const parent = views.find(view => view.id === event.targetId);
				if (!parent) { throw new Error('BrowserTargetUnavailable'); }
				return this.createBrowserView({ initialUrl: event.url, owner: parent.owner, session: parent.session });
			}).catch(error => console.error('Failed to open browser popup', error));
		}
	}
	protected override disposeCore(): void {
		for (const handle of this.permissionDialogs.values()) { handle.item.cancel(); }
		this.permissionDialogs.clear();
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
