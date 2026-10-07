import type { URI } from '../../../../base/common/uri.js';
import type { LanguageTextDocumentEdit } from '../../../../editor/common/languages.js';
import { WorkspaceEditConflictError } from '../../../../editor/browser/services/bulkEditService.js';
import type { ITextModelResourceService, TextModelReference } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import type { TextModelEditSource } from '../../../../editor/common/textModelEditSource.js';
import type { DisposableMap } from '../../../../base/common/lifecycle.js';

interface TextOperation {
	readonly entry: LanguageTextDocumentEdit;
	readonly model: { readonly reference: TextModelReference; readonly wasOpen: boolean; version: number; };
	readonly before: string;
	readonly after: string;
}

/** Applies a preflighted text step through the shared model and retains its exact inverse. */
export class BulkTextEdits {
	constructor(
		private readonly operation: TextOperation,
		private readonly models: ITextModelResourceService,
		private readonly inverses: (() => Promise<void>)[],
		private readonly failedSaves: DisposableMap<string, TextModelReference>,
		private readonly signal: AbortSignal,
		private readonly reason: TextModelEditSource | undefined,
		private readonly skipSave: boolean,
	) { }

	public async apply(): Promise<readonly URI[]> {
		const { entry, model, before, after } = this.operation;
		if (model.reference.model.version !== model.version) {
			throw new WorkspaceEditConflictError(`Workspace edit for '${entry.resource.toString()}' is stale`);
		}
		if (model.reference.model.getText() !== before) {
			throw new WorkspaceEditConflictError(`Workspace edit content for '${entry.resource.toString()}' changed during application`);
		}
		if (before === after) {
			return [];
		}
		model.reference.model.applyOperations(entry.edits, { editSource: this.reason });
		model.version = model.reference.model.version;
		const appliedVersion = model.reference.model.getAlternativeVersionId();
		this.inverses.push(() => this.undoText(appliedVersion));
		if (!model.wasOpen && !this.skipSave) {
			try {
				// These writes persist the workspace transaction, rather than starting a user save.
				await model.reference.save(this.signal, { skipSaveParticipants: true });
			} catch (error) {
				this.failedSaves.set(entry.resource.toString(), model.reference);
				throw error;
			}
		}
		if (model.reference.model.getText() !== after) {
			throw new WorkspaceEditConflictError(`Workspace edit for '${entry.resource.toString()}' produced an inconsistent result`);
		}
		return [entry.resource];
	}

	private async undoText(appliedVersion: number): Promise<void> {
		const { entry, before, after, model } = this.operation;
		using reference = await this.models.acquire({ resource: entry.resource }, new AbortController().signal);
		if (reference.model.getText() !== after || reference.model.getAlternativeVersionId() !== appliedVersion) {
			throw new WorkspaceEditConflictError(`Workspace edit target '${entry.resource.toString()}' changed before replacement`);
		}
		if (!reference.model.undo() || reference.model.getText() !== before) {
			throw new WorkspaceEditConflictError(`Workspace edit for '${entry.resource.toString()}' is no longer the latest undo step`);
		}
		if (!model.wasOpen && !this.skipSave) {
			await reference.save(new AbortController().signal, { skipSaveParticipants: true });
			if (this.failedSaves.get(entry.resource.toString()) === model.reference) {
				this.failedSaves.deleteAndDispose(entry.resource.toString());
			}
		}
	}
}
