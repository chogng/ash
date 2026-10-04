import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IBrowserViewService, BrowserViewStorageScope, normalizeBrowserViewUrl, type IBrowserViewSessionOptions } from '../../../../platform/browserView/common/browserView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import { type EditorInputSerializer, requireRecord, requireString } from '../../../services/editor/common/editorInputSerializer.js';
import { BrowserViewModel, IBrowserViewWorkbenchService, type IBrowserViewModel } from './browserView.js';
export const BROWSER_RESOURCE_SCHEME = 'ash-browser';

export interface IBrowserEditorInputData {
	readonly id: string;
	readonly url: string;
	readonly title: string;
	readonly session: IBrowserViewSessionOptions;
}

export class BrowserEditorInput extends Disposable implements EditorInput {
	readonly resource: URI;
	readonly readOnly = true;
	readonly showBreadcrumbs = false;
	private readonly labelChange = this._register(new Emitter<void>());
	readonly onDidChangeLabel = this.labelChange.event;
	private readonly model = this._register(new MutableDisposable<BrowserViewModel>());
	private resolution: Promise<IBrowserViewModel> | undefined;

	constructor(
		private readonly data: IBrowserEditorInputData,
		@IBrowserViewService private readonly service: IBrowserViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.resource = URI.parse(`${BROWSER_RESOURCE_SCHEME}:/${data.id}`);
	}

	public get label(): string {
		const state = this.model.value?.state;
		const url = state?.url ?? this.data.url;
		const title = state?.title ?? this.data.title;
		if (url === 'about:blank') { return localize({ bundle: 'ash.workbench', key: 'browser.title' }, 'Browser'); }
		return title.trim() || new URL(url).host;
	}

	public resolve(): Promise<IBrowserViewModel> {
		this.assertNotDisposed();
		if (!this.resolution) {
			this.resolution = this.resolveModel();
		}
		return this.resolution;
	}

	private async resolveModel(): Promise<IBrowserViewModel> {
		const info = await this.service.getOrCreateBrowserView(this.data.id, { initialUrl: this.data.url, owner: { type: 'user' }, session: this.data.session });
		this.assertNotDisposed();
		const model = this.instantiationService.createInstance(BrowserViewModel, info);
		this.model.value = model;
		model.onDidChangeState(() => this.labelChange.fire(), undefined, this._store);
		await model.initialize();
		return model;
	}

	public serialize(): IBrowserEditorInputData {
		const info = this.model.value?.info;
		const session = info?.session ?? this.data.session;
		// Restoring a tab restores user presentation, never an agent's authority or in-memory login.
		const restoredSession = session.scope === BrowserViewStorageScope.Agent ? { scope: BrowserViewStorageScope.Ephemeral as const } : session;
		return { id: this.data.id, url: info?.state.url ?? this.data.url, title: info?.state.title ?? this.data.title, session: restoredSession };
	}
}

export class BrowserEditorSerializer implements EditorInputSerializer {
	public readonly typeId = 'workbench.editorInput.browser';

	constructor(@IBrowserViewWorkbenchService private readonly views: IBrowserViewWorkbenchService) { }

	public canSerialize(input: EditorInput): boolean { return input instanceof BrowserEditorInput; }
	public serialize(input: EditorInput): unknown {
		if (!(input instanceof BrowserEditorInput)) { throw new TypeError('Expected browser editor input'); }
		return input.serialize();
	}
	public deserialize(value: unknown): EditorInput {
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

