import type { IResourceEditorInput } from '../../../common/editor.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IBrowserViewService, BrowserViewStorageScope, normalizeBrowserViewUrl, type IBrowserViewSessionOptions } from '../../../../platform/browserView/common/browserView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

import { type EditorInputSerializer, requireRecord, requireString } from '../../../services/editor/common/editorInputSerializer.js';
import { BrowserViewModel, IBrowserViewWorkbenchService, type IBrowserViewModel } from './browserView.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';

export interface IBrowserEditorInputData {
	readonly id: string;
	readonly url: string;
	readonly title: string;
	readonly session: IBrowserViewSessionOptions;
}

export class BrowserEditorInput extends EditorInput {
	public readonly typeId = 'workbench.editorInput.browser';
	readonly resource: URI;
	readonly readOnly = true;
	readonly showBreadcrumbs = false;
	private readonly labelChange = this._register(new Emitter<void>());
	readonly onDidChangeLabel = this.labelChange.event;
	private readonly resolvedModel = this._register(new MutableDisposable<BrowserViewModel>());
	private readonly modelListeners = this._register(new DisposableStore());
	private readonly modelResolved = this._register(new Emitter<IBrowserViewModel>());
	public readonly onDidResolveModel = this.modelResolved.event;
	private resolution: Promise<IBrowserViewModel> | undefined;
	private isClosed = false;

	constructor(
		private data: IBrowserEditorInputData,
		@IBrowserViewService private readonly service: IBrowserViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.resource = BrowserViewUri.forId(data.id);
	}

	public get id(): string { return this.data.id; }
	public get model(): IBrowserViewModel | undefined { return this.resolvedModel.value; }

	/** Attach Main's discovered page without creating another page or changing its owner. */
	public set model(model: BrowserViewModel) {
		this.assertNotDisposed();
		if (this.resolvedModel.value === model) { return; }
		this.modelListeners.clear();
		this.resolvedModel.value = model;
		this.modelListeners.add(model.onDidChangeState(() => this.labelChange.fire()));
		this.modelListeners.add(model.onDidClose(() => { this.isClosed = true; }));
		this.labelChange.fire();
		this.modelResolved.fire(model);
	}

	public getName(): string {
		const state = this.model?.state;
		const url = state?.url ?? this.data.url;
		const title = state?.title ?? this.data.title;
		if (url === 'about:blank') { return localize({ bundle: 'ash.workbench', key: 'browser.title' }, 'Browser'); }
		return title.trim() || new URL(url).host;
	}

	public resolve(): Promise<IBrowserViewModel> {
		this.assertNotDisposed();
		if (this.isClosed) { throw new Error('BrowserTargetUnavailable'); }
		if (!this.resolution) {
			this.resolution = this.resolveModel().catch(error => {
				this.resolution = undefined;
				throw error;
			});
		}
		return this.resolution;
	}

	private async resolveModel(): Promise<IBrowserViewModel> {
		if (!this.model) {
			const info = await this.service.getOrCreateBrowserView(this.data.id, { initialUrl: this.data.url, owner: { type: 'user' }, session: this.data.session });
			this.assertNotDisposed();
			// Discovery may have attached the model while the create response was in flight.
			if (!this.model) { this.model = this.instantiationService.createInstance(BrowserViewModel, info); }
		}
		const model = this.resolvedModel.value!;
		try {
			await model.initialize();
			return model;
		} catch (error) {
			this.modelListeners.clear();
			this.resolvedModel.clear();
			throw error;
		}
	}

	public serialize(): IBrowserEditorInputData {
		const info = this.model?.info;
		const session = info?.session ?? this.data.session;
		// Restoring a tab restores user presentation, never an agent's authority or in-memory login.
		const restoredSession = session.scope === BrowserViewStorageScope.Agent ? { scope: BrowserViewStorageScope.Ephemeral as const } : session;
		return { id: this.data.id, url: info?.state.url ?? this.data.url, title: info?.state.title ?? this.data.title, session: restoredSession };
	}

	protected override disposeCore(): void {
		// Model detachment must not replace the last displayed URL/title with the restoration snapshot.
		this.data = this.serialize();
		super.disposeCore();
	}
}

export class BrowserEditorSerializer implements EditorInputSerializer {
	public readonly typeId = 'workbench.editorInput.browser';

	constructor(@IBrowserViewWorkbenchService private readonly views: IBrowserViewWorkbenchService) { }

	public canSerialize(input: IResourceEditorInput): boolean { return input instanceof BrowserEditorInput; }
	public serialize(input: IResourceEditorInput): unknown {
		if (!(input instanceof BrowserEditorInput)) { throw new TypeError('Expected browser editor input'); }
		return input.serialize();
	}
	public deserialize(value: unknown): IResourceEditorInput {
		const data = requireRecord(value, 'browser editor');
		const id = requireString(data.id, 'browser editor id');
		if (!/^browser_target_[0-9a-f-]{36}$/.test(id)) { throw new TypeError('Invalid browser editor id'); }
		const session = requireRecord(data.session, 'browser storage');
		if (session.scope !== BrowserViewStorageScope.Global && session.scope !== BrowserViewStorageScope.Workspace && session.scope !== BrowserViewStorageScope.Ephemeral) {
			throw new TypeError('Invalid restored browser storage');
		}
		if (typeof data.title !== 'string') { throw new TypeError('Invalid browser editor title'); }
		return this.views.getOrCreateLazy({ id, url: normalizeBrowserViewUrl(data.url), title: data.title, session: { scope: session.scope } });
	}
}
