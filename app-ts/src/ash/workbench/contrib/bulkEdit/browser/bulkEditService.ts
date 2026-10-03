import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { normalizeLanguageWorkspaceEdit, type LanguageTextDocumentEdit, type LanguageWorkspaceEdit, type LanguageWorkspaceEditEntry } from "../../../../editor/common/languages.js";
import { type IBulkEditOptions, type IBulkEditPreviewHandler, type IBulkEditResult, type IBulkEditService, ResourceEdit, ResourceFileEdit, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { IWorkspaceEditService, type WorkspaceEditResult } from "../../../services/language/common/workspaceEditService.js";
import { localize } from '../../../../nls.js';

// The language contract groups edits by snapshot. Keep that boundary when preview
// selects individual replacements, including sequential edits to the same resource.
class SnapshotTextEdit extends ResourceTextEdit {
	constructor(public readonly snapshot: LanguageTextDocumentEdit, textEdit: ResourceTextEdit['textEdit']) {
		super(snapshot.resource, textEdit, snapshot.version);
	}
}

/** Adds Workbench preview policy to the ordered workspace-edit transaction. */
export class BulkEditService extends Disposable implements IBulkEditService {
	declare readonly _serviceBrand: undefined;
	private previewHandler: IBulkEditPreviewHandler | undefined;

	constructor(@IWorkspaceEditService private readonly workspaceEdits: IWorkspaceEditService) {
		super();
		this._register(toDisposable(() => { this.previewHandler = undefined; }));
	}

	hasPreviewHandler(): boolean {
		return this.previewHandler !== undefined;
	}

	setPreviewHandler(handler: IBulkEditPreviewHandler): ReturnType<typeof toDisposable> {
		this.assertNotDisposed();
		this.previewHandler = handler;
		return toDisposable(() => {
			if (this.previewHandler === handler) this.previewHandler = undefined;
		});
	}

	async apply(value: ResourceEdit[] | LanguageWorkspaceEdit, options: IBulkEditOptions = {}): Promise<IBulkEditResult> {
		this.assertNotDisposed();
		const sourceEdit = Array.isArray(value) ? undefined : normalizeLanguageWorkspaceEdit(value);
		let edits: ResourceEdit[];
		if (Array.isArray(value)) {
			edits = value.map(edit => {
				if (ResourceTextEdit.is(edit)) return ResourceTextEdit.lift(edit);
				if (ResourceFileEdit.is(edit)) return ResourceFileEdit.lift(edit);
				throw new TypeError('Unknown resource edit');
			});
		} else {
			edits = sourceEdit!.entries.flatMap(entry => entry.kind === 'textDocument'
				? entry.edits.map(textEdit => new SnapshotTextEdit(entry, textEdit))
				: ResourceEdit.convert({ entries: [entry] }));
		}
		const signal = options.token ?? new AbortController().signal;
		throwIfCancelled(signal);
		if (edits.length === 0) return { ariaSummary: localize('bulkEdit.noneApplied', 'No edits were applied'), isApplied: false };
		const originalTextEdits = new Map(edits.filter((edit): edit is SnapshotTextEdit => edit instanceof SnapshotTextEdit).map(edit => [edit.textEdit, edit]));
		let previewed = false;
		if (options.showPreview === true || edits.some(edit => edit.metadata?.needsConfirmation) || (options.showPreview !== false && edits.length > 1 && this.previewHandler)) {
			const previewHandler = this.previewHandler;
			if (!previewHandler) throw new Error("Bulk edit preview is not available");
			edits = await previewHandler(edits, { ...options, token: signal });
			edits = edits.map(edit => edit instanceof ResourceTextEdit ? originalTextEdits.get(edit.textEdit) ?? edit : edit);
			previewed = true;
			if (signal.aborted || edits.length === 0) return { ariaSummary: localize('bulkEdit.noneApplied', 'No edits were applied'), isApplied: false };
		}
		const edit = sourceEdit && !previewed ? sourceEdit : await toLanguageWorkspaceEdit(edits);
		throwIfCancelled(signal);
		if (edit.entries.length === 0) return { ariaSummary: localize('bulkEdit.noneApplied', 'No edits were applied'), isApplied: false };
		// Approval transfers ownership to the transaction. Its own document changes can retire
		// the originating language request, which must not cancel an approved multi-file commit.
		const result: WorkspaceEditResult = await this.workspaceEdits.apply(edit, previewed ? undefined : signal, options.progress);
		if (result.resources.length === 0) return { ariaSummary: localize('bulkEdit.noneApplied', 'No edits were applied'), isApplied: false };
		return { ariaSummary: localize('bulkEdit.resourcesChanged', '{0} resources changed', result.resources.length), isApplied: true, undo: result.undo };
	}
}

export async function toLanguageWorkspaceEdit(edits: readonly ResourceEdit[]): Promise<LanguageWorkspaceEdit> {
	const entries: LanguageWorkspaceEditEntry[] = [];
	const groups = new Map<string, { kind: 'textDocument'; resource: ResourceTextEdit['resource']; version?: number; expectedText?: string; edits: ResourceTextEdit['textEdit'][] }>();
	let snapshot: LanguageTextDocumentEdit | undefined;
	const flushText = (): void => {
		entries.push(...groups.values());
		groups.clear();
	};
	for (const edit of edits) {
		if (edit instanceof ResourceTextEdit) {
			const currentSnapshot = edit instanceof SnapshotTextEdit ? edit.snapshot : undefined;
			if (snapshot !== currentSnapshot) {
				flushText();
				snapshot = currentSnapshot;
			}
			const key = edit.resource.toString();
			let group = groups.get(key);
			if (!group) {
				group = { kind: 'textDocument', resource: edit.resource, version: edit.versionId, expectedText: snapshot?.expectedText, edits: [] };
				groups.set(key, group);
			} else if (edit.versionId !== undefined) {
				if (group.version !== undefined && group.version !== edit.versionId) throw new Error(`Conflicting workspace edit versions for ${key}`);
				group.version = edit.versionId;
			}
			group.edits.push(edit.textEdit);
			continue;
		}
		flushText();
		snapshot = undefined;
		if (!(edit instanceof ResourceFileEdit)) throw new TypeError('Unknown resource edit');
		if (edit.oldResource && edit.newResource) entries.push({ kind: 'rename', source: edit.oldResource, target: edit.newResource, existing: existing(edit.options) });
		else if (edit.newResource) entries.push({ kind: 'create', resource: edit.newResource, existing: existing(edit.options), ...(edit.options.contents ? { contents: (await edit.options.contents).toString() } : {}) });
		else entries.push({ kind: 'delete', resource: edit.oldResource!, missing: edit.options.ignoreIfNotExists ? 'ignore' : 'error', mode: edit.options.recursive ? 'recursive' : 'fileOrEmptyDirectory' });
	}
	flushText();
	return normalizeLanguageWorkspaceEdit({ entries });
}

function existing(options: ResourceFileEdit['options']): 'error' | 'overwrite' | 'ignore' {
	return options.ignoreIfExists ? 'ignore' : options.overwrite ? 'overwrite' : 'error';
}
