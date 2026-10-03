import { Emitter } from '../../../../../base/common/event.js';
import { TaskQueue } from '../../../../../base/common/async.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import type { URI } from '../../../../../base/common/uri.js';
import { IBulkEditService, ResourceFileEdit, ResourceTextEdit, type IBulkEditResult, ResourceEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import type { LanguageWorkspaceEdit } from '../../../../../editor/common/languages.js';
import { ITextModelResourceService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { localize } from '../../../../../nls.js';
import { IChatEditingService, type IModifiedFileEntry, type IModifiedFileEntryChangeHunk } from '../../common/editing/chatEditingService.js';
import { ChatEditingModifiedDocumentEntry } from './chatEditingModifiedDocumentEntry.js';

export class ChatEditingService extends Disposable implements IChatEditingService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly reviews = this._register(new DisposableMap<string, IModifiedFileEntry>());
	private readonly operations = new TaskQueue();

	constructor(@IBulkEditService private readonly bulkEdits: IBulkEditService, @ITextModelResourceService private readonly models: ITextModelResourceService) { super(); this._register(toDisposable(() => this.operations.clearPending())); }

	public get entries(): readonly IModifiedFileEntry[] { return [...this.reviews].map(([, entry]) => entry); }

	public applyEdits(edit: LanguageWorkspaceEdit, signal: AbortSignal): Promise<IBulkEditResult> {
		return this.operations.schedule(() => this.applyEdit(edit, signal));
	}

	private async applyEdit(edit: LanguageWorkspaceEdit, signal: AbortSignal): Promise<IBulkEditResult> {
		this.assertNotDisposed();
		signal.throwIfAborted();
		const edits = ResourceEdit.convert(edit);
		const documents = new Set<ChatEditingModifiedDocumentEntry>();
		try {
			const fileEdits = edits.filter((edit): edit is ResourceFileEdit => edit instanceof ResourceFileEdit);
			const resources = new Map<string, URI>();
			for (const edit of edits) {
				for (const resource of edit instanceof ResourceTextEdit ? [edit.resource] : edit instanceof ResourceFileEdit ? [edit.oldResource, edit.newResource] : []) {
					if (resource) { resources.set(extUriBiasedIgnorePathCase.getComparisonKey(resource), resource); }
				}
			}
			const previous = new Map<string, IModifiedFileEntry>();
			for (const [key, entry] of this.reviews) {
				if (entry.resources.some(resource => resources.has(extUriBiasedIgnorePathCase.getComparisonKey(resource)))) { previous.set(key, entry); }
			}
			const atomic = fileEdits.length > 0 || [...previous.values()].some(entry => entry instanceof ChatEditingFileOperationEntry);
			if (atomic) {
				// A later tool may edit a newly created or moved file. Its inverse joins the
				// earlier operation so review never restores only half of a resource change.
				for (const entry of previous.values()) {
					for (const resource of entry.resources) { resources.set(extUriBiasedIgnorePathCase.getComparisonKey(resource), resource); }
					if (entry instanceof ChatEditingModifiedDocumentEntry) {
						entry.beginAgentEdit(edits.filter((edit): edit is ResourceTextEdit => edit instanceof ResourceTextEdit && extUriBiasedIgnorePathCase.isEqual(edit.resource, entry.modifiedURI)).map(edit => edit.textEdit));
						documents.add(entry);
					}
				}
			} else {
				for (const resource of resources.values()) {
					const key = extUriBiasedIgnorePathCase.getComparisonKey(resource);
					let entry = this.reviews.get(key) as ChatEditingModifiedDocumentEntry | undefined;
					if (!entry) {
						const reference = await this.models.acquire({ resource }, signal);
						try { signal.throwIfAborted(); this.assertNotDisposed(); }
						catch (error) { reference.dispose(); throw error; }
						entry = new ChatEditingModifiedDocumentEntry(resource, reference, () => this.remove(key), () => this.changed.fire());
						this.reviews.set(key, entry);
					}
					entry.beginAgentEdit(edits.filter((edit): edit is ResourceTextEdit => edit instanceof ResourceTextEdit && extUriBiasedIgnorePathCase.isEqual(edit.resource, resource)).map(edit => edit.textEdit));
					documents.add(entry);
				}
			}
			const result = await this.bulkEdits.apply(edit, { token: signal, showPreview: false });
			if (result.isApplied && atomic) {
				for (const entry of documents) { entry.endAgentEdit(); }
				documents.clear();
				const retained: IModifiedFileEntry[] = [];
				for (const key of previous.keys()) {
					const entry = this.reviews.deleteAndLeak(key);
					if (entry) { retained.push(entry); }
				}
				const entry = new ChatEditingFileOperationEntry([...resources.values()], result.undo, retained, () => this.remove(entry.id), () => this.changed.fire());
				this.reviews.set(entry.id, entry);
			}
			return result;
		} finally {
			for (const entry of documents) { entry.endAgentEdit(); }
			this.changed.fire();
		}
	}

	public acceptEntry(entry: IModifiedFileEntry, hunk?: IModifiedFileEntryChangeHunk): Promise<void> {
		return this.operations.schedule(async () => { this.requireEntry(entry); await entry.accept(hunk); });
	}

	public rejectEntry(entry: IModifiedFileEntry, hunk?: IModifiedFileEntryChangeHunk): Promise<void> {
		return this.operations.schedule(async () => { this.requireEntry(entry); await entry.reject(hunk); });
	}

	public accept(...resources: URI[]): Promise<void> {
		return this.operations.schedule(async () => { this.assertNotDisposed(); for (const entry of this.selected(resources)) { await entry.accept(); } });
	}

	public reject(...resources: URI[]): Promise<void> {
		return this.operations.schedule(async () => { this.assertNotDisposed(); for (const entry of this.selected(resources)) { await entry.reject(); } });
	}

	private requireEntry(entry: IModifiedFileEntry): void {
		this.assertNotDisposed();
		if (!this.entries.includes(entry)) { throw new Error(localize('chatEditing.stale', 'The change has changed. Review it again.')); }
	}

	private selected(resources: readonly URI[]): readonly IModifiedFileEntry[] {
		return this.entries.filter(entry => resources.length === 0 || entry.resources.some(resource => resources.some(selected => extUriBiasedIgnorePathCase.isEqual(selected, resource))));
	}

	private remove(key: string): void { this.reviews.deleteAndDispose(key); this.changed.fire(); }
}

class ChatEditingFileOperationEntry extends Disposable implements IModifiedFileEntry {
	public readonly isFileOperation = true;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	public readonly id = crypto.randomUUID();
	public readonly hunks = [];
	public isBusy = false;
	public readonly modifiedURI: URI;
	private reverted = false;
	private readonly remaining: IModifiedFileEntry[];

	constructor(public readonly resources: readonly URI[], private readonly undo: () => Promise<void>, previous: readonly IModifiedFileEntry[], private readonly complete: () => void, notify: () => void) {
		super();
		this._register(this.onDidChange(notify));
		for (const entry of previous) { this._register(entry); }
		this.remaining = [...previous].reverse();
		this.modifiedURI = resources[resources.length - 1]!;
	}

	public async accept(): Promise<void> { if (!this.isBusy) { this.complete(); } }
	public async reject(): Promise<void> {
		if (this.isBusy) { return; }
		this.isBusy = true;
		this.changed.fire();
		try {
			if (!this.reverted) {
				const documents = this.remaining.filter((entry): entry is ChatEditingModifiedDocumentEntry => entry instanceof ChatEditingModifiedDocumentEntry);
				for (const entry of documents) { entry.beginRestore(); }
				try { await this.undo(); this.reverted = true; }
				finally { for (const entry of documents) { entry.endAgentEdit(); } }
			}
			while (this.remaining.length > 0) { await this.remaining[0]!.reject(); this.remaining.shift(); }
		}
		finally { this.isBusy = false; this.changed.fire(); }
		this.complete();
	}
	public getAccessibleContent(): string { return localize('chatEditing.atomicFiles', 'Atomic file operation affecting:\n{0}', this.resources.map(resource => resource.fsPath).join('\n')); }
}
