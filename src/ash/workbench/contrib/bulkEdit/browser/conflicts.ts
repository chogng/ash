import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { ResourceEdit, ResourceFileEdit, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IFileTextModelService } from '../../../services/textmodelResolver/common/textModelResourceService.js';

/** A preview is tied to the resources it read, even when the request has no version. */
export class ConflictDetector extends Disposable {
	private readonly resources = new Map<string, URI>();
	private readonly conflicts = new Set<string>();
	private readonly modelListeners = this._register(new DisposableMap<string, DisposableStore>());
	private readonly conflictEmitter = this._register(new Emitter<this>());
	public readonly onDidConflict = this.conflictEmitter.event;

	constructor(
		edits: ResourceEdit[],
		@IFileService files: IFileService,
		@IFileTextModelService models: IFileTextModelService,
	) {
		super();
		for (const edit of edits) {
			const resources: (URI | undefined)[] = [];
			if (edit instanceof ResourceTextEdit) resources.push(edit.resource);
			else if (edit instanceof ResourceFileEdit) resources.push(edit.oldResource, edit.newResource);
			for (const resource of resources) {
				if (resource) this.resources.set(extUriBiasedIgnorePathCase.getComparisonKey(resource), resource);
			}
			if (edit instanceof ResourceTextEdit) {
				const model = models.getModel(edit.resource);
				if (model && edit.versionId !== undefined && model.version !== edit.versionId) {
					this.conflicts.add(extUriBiasedIgnorePathCase.getComparisonKey(edit.resource));
				}
			}
		}
		const observe = (model: TextModel): void => {
			const key = extUriBiasedIgnorePathCase.getComparisonKey(model.uri);
			if (!this.resources.has(key) || this.modelListeners.has(key)) return;
			const lifetime = new DisposableStore();
			this.modelListeners.set(key, lifetime);
			lifetime.add(model.onDidChangeContent(() => this.markConflict(key)));
			lifetime.add(model.onWillDispose(() => this.modelListeners.deleteAndDispose(key)));
		};
		this._register(models.onModelAdded(observe));
		for (const resource of this.resources.values()) {
			const model = models.getModel(resource);
			if (model) observe(model);
		}
		this._register(files.onDidChangeFiles(event => {
			for (const [key, resource] of this.resources) {
				if (event.resources === undefined || event.resources.some(changed => extUriBiasedIgnorePathCase.isEqualOrParent(resource, changed))) {
					this.markConflict(key);
				}
			}
		}));
	}

	public list(): URI[] {
		return [...this.conflicts].map(key => this.resources.get(key)!);
	}

	public hasConflicts(): boolean {
		return this.conflicts.size > 0;
	}

	private markConflict(key: string): void {
		if (this.conflicts.has(key)) return;
		this.conflicts.add(key);
		this.conflictEmitter.fire(this);
	}
}
