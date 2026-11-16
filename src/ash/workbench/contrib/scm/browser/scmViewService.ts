import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISCMService, type ISCMRepository, type ISCMViewService } from '../common/scm.js';

/** Owns SCM selection; explicit choices remain until the active resource changes. */
export class SCMViewService extends Disposable implements ISCMViewService {
	private readonly changeEmitter = this._register(new Emitter<ISCMRepository | undefined>());
	public readonly onDidChangeActiveRepository = this.changeEmitter.event;
	private selectedId: string | undefined;
	private manualSelection = false;
	private activeResource: URI | undefined;

	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this.activeResource = this.editorResource();
		this.updateActiveRepository();
		this._register(this.editorService.onDidActiveEditorChange(() => {
			const resource = this.editorResource();
			if (!extUriBiasedIgnorePathCase.isEqualIgnoringFragment(resource, this.activeResource)) this.manualSelection = false;
			this.activeResource = resource;
			this.updateActiveRepository();
		}));
		// Repository discovery can finish after the editor has already been restored.
		this._register(this.scmService.onDidAddRepository(() => this.updateActiveRepository()));
		this._register(this.scmService.onDidRemoveRepository(repository => {
			if (repository.id !== this.selectedId) return;
			this.manualSelection = false;
			this.updateActiveRepository();
		}));
	}

	public get activeRepository(): ISCMRepository | undefined {
		return this.selectedId === undefined ? undefined : this.scmService.getRepository(this.selectedId);
	}

	public selectRepository(id: string | undefined): void {
		if (id !== undefined && !this.scmService.getRepository(id)) throw new Error(`SCM repository '${id}' is not registered`);
		this.manualSelection = id !== undefined;
		this.setActiveRepository(id);
	}

	private editorResource(): URI | undefined {
		return EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
	}

	private updateActiveRepository(): void {
		if (this.manualSelection) return;
		let match: ISCMRepository | undefined;
		for (const repository of this.scmService.repositories) {
			const root = repository.provider.rootUri;
			if (root && this.activeResource && extUriBiasedIgnorePathCase.isEqualOrParent(this.activeResource, root, true)
				&& (!match || root.path.length > match.provider.rootUri!.path.length)) match = repository;
		}
		this.setActiveRepository(match?.id ?? this.activeRepository?.id ?? this.scmService.repositories[Symbol.iterator]().next().value?.id);
	}

	private setActiveRepository(id: string | undefined): void {
		if (id === this.selectedId) return;
		this.selectedId = id;
		this.changeEmitter.fire(this.activeRepository);
	}
}
