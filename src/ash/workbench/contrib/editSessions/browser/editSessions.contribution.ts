import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { getErrorMessage, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IsNativeContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileKind, FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode, type IFileBytes, type IFileEntry } from '../../../../platform/files/common/files.js';
import { ILocalGitService, type GitWorktreeEditSnapshot, type GitWorktreeEditStatus } from '../../../../platform/git/common/localGitService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { WorkspaceFolderCountContext } from '../../../common/contextkeys.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { createMultiDiffEditorInput } from '../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { editSessionFileLimit, editSessionResource, editSessionSizeLimit, IEditSessionsStorageService, type EditSession, type EditSessionSlot, type WorkingChange } from '../common/editSessions.js';
import { editSessionPreviewResource, EditSessionsFileSystemProvider } from './editSessionsFileSystemProvider.js';
import { EditSessionsWorkbenchService } from './editSessionsStorageService.js';

const IEditSessionsContribution = createDecorator<EditSessionsContribution>('editSessionsContribution');
const resumeEditSessionId = 'workbench.editSessions.actions.resumeLatest';

interface RestoreEdit {
	readonly change: WorkingChange;
	readonly resource: URI;
	readonly before: IFileBytes | undefined;
	readonly createParent: boolean;
}

function encodeContents(bytes: Uint8Array): string {
	return encodeBase64(VSBuffer.wrap(new Uint8Array(bytes)));
}

function matchesCheckoutContents(captured: string, actual: string): boolean {
	if (captured === actual) return true;
	// Git may provide a normalized blob for staged files or the baseline, while
	// the actual checkout has CRLF. Preserve the bytes read from the working tree.
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	try {
		const text = decoder.decode(decodeBase64(captured).buffer);
		return !text.includes('\0') && decoder.decode(decodeBase64(actual).buffer) === text.replace(/(?<!\r)\n/gu, '\r\n');
	} catch {
		return false;
	}
}

function isBinary(content: string | null): boolean {
	if (content === null) return false;
	const bytes = decodeBase64(content).buffer;
	if (bytes.includes(0)) return true;
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return false;
	} catch {
		return true;
	}
}

class EditSessionsContribution extends Disposable {
	private operation: AbortController | undefined;

	constructor(
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILocalGitService private readonly git: ILocalGitService,
		@IFileService private readonly files: IFileService,
		@IEditSessionsStorageService private readonly storage: IEditSessionsStorageService,
		@IEditorService private readonly editors: IEditorService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@IUriIdentityService private readonly identity: IUriIdentityService,
		@IDialogService private readonly dialogs: IDialogService,
		@INotificationService private readonly notifications: INotificationService,
	) { super(); }

	storeEditSession(): Promise<void> {
		return this.run(async (root, signal) => {
			const starting = await this.readCheckout(root, signal);
			const saved = await this.editors.saveAll({ includeUntitled: false });
			if (!saved.success) return;
			throwIfCancelled(signal);
			const checkout = await this.git.readWorktreeEditSnapshot(root.fsPath, signal);
			if (!checkout) throw new Error(localize('editSessions.checkoutChanged', 'The Git worktree or its base commit changed. Run the command again.'));
			this.assertSameCheckout(starting, checkout);
			const changes = this.captureChanges(root, checkout);
			if (changes.length === 0) {
				this.notifications.info(localize('editSessions.noChanges', 'There are no working changes to save.'));
				return;
			}
			const directories = new Map<string, Promise<readonly IFileEntry[]>>();
			const verified: WorkingChange[] = [];
			for (const change of changes) {
				const resource = editSessionResource(root, change.path)!;
				const leaf = await this.inspectPath(root, change.path, directories);
				const after = leaf === 'file' ? await this.readContents(resource) : null;
				if (leaf === 'blocked' || change.after === null && leaf === 'file' ||
					change.after !== null && (after === null || !matchesCheckoutContents(change.after, after)) ||
					this.workingCopies.get(resource).some(copy => copy.isDirty)) {
					throw new Error(localize('editSessions.sourceChanged', 'The source changed while saving {0}. Review the file and try again.', change.path));
				}
				verified.push({ ...change, after });
			}
			this.assertSameCheckout(checkout, await this.readCheckout(root, signal));
			const slot = await this.storage.read(checkout.repositoryId);
			if (slot.kind !== 'empty') {
				const { confirmed } = await this.dialogs.confirm({
					title: localize('editSessions.replaceTitle', 'Replace Saved Working Changes'),
					message: localize('editSessions.replaceMessage', 'Replace the saved working changes for this repository?'),
					primaryButton: localize('editSessions.replace', 'Replace'),
					destructive: true,
				});
				if (!confirmed) return;
			}
			throwIfCancelled(signal);
			await this.storage.write(checkout.repositoryId, { version: 1, head: checkout.head, changes: verified }, slot.revision);
			this.notifications.info(localize('editSessions.saved', 'Working changes saved on this device. Open another worktree and run Resume Working Changes.'));
		});
	}

	reviewEditSession(): Promise<void> {
		return this.run(async (root, signal) => {
			const { repositoryId } = await this.readCheckout(root, signal);
			const slot = await this.readSavedSession(repositoryId);
			if (!slot) return;
			throwIfCancelled(signal);
			const title = localize('editSessions.reviewTitle', 'Saved Working Changes');
			const resource = URI.from({ scheme: 'ash-multi-diff', path: `/edit-sessions/${repositoryId}`, query: slot.revision });
			const items = slot.session.changes.map(change => ({
				label: this.changeLabel(change),
				fileList: { path: change.path },
				binary: isBinary(change.before) || isBinary(change.after),
				original: { resource: editSessionPreviewResource(repositoryId, slot.revision, change.path, 'before'), readOnly: true },
				modified: { resource: editSessionPreviewResource(repositoryId, slot.revision, change.path, 'after'), readOnly: true },
			}));
			const resume = localize('editSessions.previewTitle', 'Resume Working Changes');
			await this.editors.openEditor(createMultiDiffEditorInput(resource, items, title, {
				kind: 'snapshot',
				label: title,
				actions: [{ id: resumeEditSessionId, command: resumeEditSessionId, label: resume, tooltip: resume, arguments: [slot.revision] }],
			}), { pinned: true });
		});
	}

	discardEditSession(): Promise<void> {
		return this.run(async (root, signal) => {
			const { repositoryId } = await this.readCheckout(root, signal);
			const slot = await this.storage.read(repositoryId);
			if (slot.kind === 'empty') {
				this.showNoSavedChanges();
				return;
			}
			throwIfCancelled(signal);
			const { confirmed } = await this.dialogs.confirm({
				title: localize('editSessions.discardTitle', 'Discard Saved Working Changes'),
				message: localize('editSessions.discardMessage', 'Discard the saved working changes for this repository?'),
				primaryButton: localize('editSessions.discardButton', 'Discard'),
				destructive: true,
			});
			if (!confirmed) return;
			throwIfCancelled(signal);
			if (!await this.storage.clear(repositoryId, slot.revision)) this.savedChangesChanged();
			this.notifications.info(localize('editSessions.discarded', 'Saved working changes discarded.'));
		});
	}

	resumeEditSession(expectedRevision?: string): Promise<void> {
		return this.run(async (root, signal) => {
			const checkout = await this.readCheckout(root, signal);
			const slot = await this.readSavedSession(checkout.repositoryId);
			if (!slot) return;
			if (expectedRevision !== undefined && slot.revision !== expectedRevision) this.savedChangesChanged();
			const { session, revision } = slot;
			if (checkout.head !== session.head) {
				throw new Error(localize('editSessions.baselineMismatch', 'Open a worktree at the commit where the working changes were saved ({0}).', session.head.slice(0, 12)));
			}
			const plan = await this.prepareRestore(root, session, checkout);
			throwIfCancelled(signal);
			if (plan.conflicts.length) {
				await this.showConflicts(plan.conflicts);
				return;
			}
			const { confirmed } = await this.dialogs.confirm({
				title: localize('editSessions.previewTitle', 'Resume Working Changes'),
				message: localize('editSessions.preview', 'Resume working changes in this worktree?'),
				detail: session.changes.map(change => this.changeLabel(change)).join('\n'),
				primaryButton: localize('editSessions.apply', 'Restore Changes'),
			});
			if (!confirmed) return;
			throwIfCancelled(signal);

			// Revalidate the checkout and the saved record after the user confirms.
			const current = await this.readCheckout(root, signal);
			this.assertSameCheckout(checkout, current);
			const reviewed = await this.prepareRestore(root, session, current);
			if (reviewed.conflicts.length) {
				await this.showConflicts(reviewed.conflicts);
				return;
			}
			if ((await this.storage.read(checkout.repositoryId)).revision !== revision) this.savedChangesChanged();
			await this.applyRestore(root, checkout, reviewed.edits, signal);
			try {
				await this.storage.clear(checkout.repositoryId, revision);
			} catch {
				this.notifications.warn(localize('editSessions.cleanupFailed', 'Working changes were restored. The saved copy could not be cleared.'));
				return;
			}
			this.notifications.info(localize('editSessions.restored', 'Restored {0} working changes.', reviewed.edits.length));
		});
	}

	private async readSavedSession(repositoryId: string): Promise<Extract<EditSessionSlot, { kind: 'saved'; }> | undefined> {
		const slot = await this.storage.read(repositoryId);
		if (slot.kind === 'saved') return slot;
		if (slot.kind === 'invalid') {
			throw new Error(localize('editSessions.readFailed', 'Could not read the saved working changes.'), { cause: slot.error });
		}
		this.showNoSavedChanges();
		return undefined;
	}

	private showNoSavedChanges(): void {
		this.notifications.info(localize('editSessions.noSession', 'This repository has no saved working changes on this device.'));
	}

	private savedChangesChanged(): never {
		throw new Error(localize('editSessions.savedChanged', 'The saved working changes changed in another window. Run the command again.'));
	}

	private async run(action: (root: URI, signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.operation) return;
		const workspace = this.workspace.getWorkspace();
		const root = workspace.folders.length === 1 && workspace.folders[0].uri;
		if (!root || root.scheme !== Schemas.file || workspace.remoteAuthority) {
			this.notifications.warn(localize('editSessions.localFolder', 'Open a local Git worktree as the only workspace folder.'));
			return;
		}
		const operation = this.operation = new AbortController();
		using workspaceChange = this.workspace.onDidChangeWorkspace(() => operation.abort());
		try {
			await action(root, operation.signal);
		} catch (error) {
			if (!isCancellationError(error)) this.notifications.error(getErrorMessage(error));
		} finally {
			this.operation = undefined;
		}
	}

	private async readCheckout(root: URI, signal: AbortSignal): Promise<GitWorktreeEditStatus> {
		throwIfCancelled(signal);
		const checkout = await this.git.readWorktreeEditStatus(root.fsPath, signal);
		if (!checkout) {
			throw new Error(localize('editSessions.checkoutRequired', 'Open the root of a Git worktree with at least one commit.'));
		}
		return checkout;
	}

	private assertSameCheckout(
		before: Pick<GitWorktreeEditStatus, 'repositoryId' | 'head'>,
		after: Pick<GitWorktreeEditStatus, 'repositoryId' | 'head'>,
	): void {
		if (before.repositoryId !== after.repositoryId || before.head !== after.head) {
			throw new Error(localize('editSessions.checkoutChanged', 'The Git worktree or its base commit changed. Run the command again.'));
		}
	}

	private captureChanges(root: URI, checkout: GitWorktreeEditSnapshot): readonly WorkingChange[] {
		const unsupported = [...checkout.unsupportedPaths];
		const changes: WorkingChange[] = [];
		for (const file of checkout.files) {
			if (file.omitted || !editSessionResource(root, file.path) || file.originalPath && !editSessionResource(root, file.originalPath)) {
				unsupported.push(file.path);
				continue;
			}
			const before = file.original === null ? null : encodeContents(file.original);
			const after = file.modified === null ? null : encodeContents(file.modified);
			if (file.originalPath && file.originalPath !== file.path) {
				if (before !== null) changes.push({ path: file.originalPath, before, after: null });
				if (after !== null) changes.push({ path: file.path, before: null, after });
			} else if (before !== after) {
				changes.push({ path: file.path, before, after });
			} else if (before !== null) {
				unsupported.push(file.path);
			}
		}
		if (unsupported.length) {
			throw new Error(localize('editSessions.unsupportedChanges', 'Some changes cannot be saved as regular files. Review these paths: {0}', unsupported.slice(0, 10).join(', ')));
		}
		if (changes.length > editSessionFileLimit) {
			throw new Error(localize('editSessions.fileLimit', 'Save at most {0} changed files at a time.', editSessionFileLimit));
		}
		const resources = changes.map(change => editSessionResource(root, change.path)!);
		if (resources.some((resource, index) => resources.slice(0, index).some(other => this.overlaps(resource, other)))) {
			throw new Error(localize('editSessions.overlappingPaths', 'Some changes refer to the same path or overlap. Review them before saving.'));
		}
		return changes;
	}

	private async prepareRestore(root: URI, session: EditSession, checkout: GitWorktreeEditStatus): Promise<{ edits: RestoreEdit[]; conflicts: WorkingChange[]; }> {
		const edits: RestoreEdit[] = [];
		const conflicts: WorkingChange[] = [];
		const seen: URI[] = [];
		const directories = new Map<string, Promise<readonly IFileEntry[]>>();
		const changedPaths = checkout.changedPaths
			.map(path => editSessionResource(root, path))
			.filter((resource): resource is URI => resource !== undefined);
		for (const change of session.changes) {
			const resource = editSessionResource(root, change.path);
			if (!resource || seen.some(other => this.overlaps(resource, other)) ||
				changedPaths.some(other => this.overlaps(resource, other)) ||
				this.workingCopies.get(resource).some(copy => copy.isDirty)) {
				conflicts.push(change);
				continue;
			}
			seen.push(resource);
			const leaf = await this.inspectPath(root, change.path, directories);
			if (leaf === 'blocked' || change.before === null && leaf === 'file' ||
				change.before !== null && leaf !== 'file') {
				conflicts.push(change);
				continue;
			}
			const before = leaf === 'file' ? await this.files.readFileBytes(resource, { size: editSessionSizeLimit }) : undefined;
			if (before && (!matchesCheckoutContents(change.before!, encodeContents(before.bytes)) || (await this.files.stat(resource)).readonly)) {
				conflicts.push(change);
				continue;
			}
			edits.push({ change, resource, before, createParent: leaf === 'missingParent' });
		}
		return { edits, conflicts };
	}

	private async applyRestore(root: URI, checkout: GitWorktreeEditStatus, edits: readonly RestoreEdit[], signal: AbortSignal): Promise<void> {
		const undo: (() => Promise<unknown>)[] = [];
		try {
			for (const { change, resource, before, createParent } of edits) {
				throwIfCancelled(signal);
				// Recheck path kinds as well as bytes. Directory entries expose links
				// that a provider's stat can resolve to an ordinary file.
				const leaf = await this.inspectPath(root, change.path, new Map());
				if (leaf === 'blocked' || (leaf === 'file') !== (before !== undefined) ||
					this.workingCopies.get(resource).some(copy => copy.isDirty)) {
					throw new Error(localize('editSessions.targetChanged', 'The target changed after the preview: {0}', change.path));
				}
				throwIfCancelled(signal);
				if (change.after === null && before) {
					await this.files.deleteFileIfUnchanged(resource, before.revision);
					undo.push(() => this.files.writeFileBytes(resource, before.bytes));
				} else if (change.after !== null) {
					if (createParent && leaf === 'missingParent') {
						await this.files.createDirectory(dirname(resource));
						if (await this.inspectPath(root, change.path, new Map()) !== 'missing') {
							throw new Error(localize('editSessions.targetChanged', 'The target changed after the preview: {0}', change.path));
						}
					}
					throwIfCancelled(signal);
					const { revision } = await this.files.writeFileBytes(resource, decodeBase64(change.after).buffer, {
						create: before === undefined,
						overwrite: before !== undefined,
						expectedRevision: before?.revision,
					});
					undo.push(() => before
						? this.files.writeFileBytes(resource, before.bytes, { create: false, overwrite: true, expectedRevision: revision })
						: this.files.deleteFileIfUnchanged(resource, revision));
				}
			}
			this.assertSameCheckout(checkout, await this.readCheckout(root, signal));
		} catch (error) {
			const failures: unknown[] = [];
			for (const restore of undo.reverse()) {
				try { await restore(); } catch (failure) { failures.push(failure); }
			}
			if (failures.length) {
				throw new Error(localize('editSessions.partialRestore', 'Restore failed and some changes could not be rolled back. The saved working changes are still available.'), {
					cause: new AggregateError([error, ...failures]),
				});
			}
			throw error;
		}
	}

	private async inspectPath(root: URI, path: string, directories: Map<string, Promise<readonly IFileEntry[]>>): Promise<'file' | 'missing' | 'missingParent' | 'blocked'> {
		let directory = root;
		const segments = path.split('/');
		for (const [index, segment] of segments.entries()) {
			const candidate = directory.joinPathSegment(segment);
			const key = this.identity.extUri.getComparisonKey(directory);
			let entries = directories.get(key);
			if (!entries) {
				entries = this.files.readDirectory(directory);
				directories.set(key, entries);
			}
			const entry = (await entries).find(entry => this.identity.extUri.isEqual(entry.resource, candidate));
			if (index === segments.length - 1) {
				return !entry ? 'missing' : entry.kind === FileKind.File ? 'file' : 'blocked';
			}
			if (!entry) return 'missingParent';
			if (entry.kind !== FileKind.Directory) return 'blocked';
			directory = candidate;
		}
		return 'blocked';
	}

	private async readContents(resource: URI): Promise<string> {
		const { bytes } = await this.files.readFileBytes(resource, { size: editSessionSizeLimit });
		return encodeContents(bytes);
	}

	private overlaps(a: URI, b: URI): boolean {
		const { extUri } = this.identity;
		return extUri.isEqualOrParent(a, b) || extUri.isEqualOrParent(b, a);
	}

	private changeLabel(change: WorkingChange): string {
		if (change.before === null) return localize('editSessions.add', 'Add {0}', change.path);
		if (change.after === null) return localize('editSessions.delete', 'Delete {0}', change.path);
		return localize('editSessions.modify', 'Modify {0}', change.path);
	}

	private showConflicts(conflicts: readonly WorkingChange[]): Promise<void> {
		return this.dialogs.warn(
			localize('editSessions.conflicts', 'Resolve these conflicts before restoring working changes.'),
			conflicts.map(change => this.changeLabel(change)).join('\n'),
		);
	}

	override dispose(): void {
		this.operation?.abort();
		super.dispose();
	}
}

registerSingleton(IEditSessionsStorageService, EditSessionsWorkbenchService, InstantiationType.Delayed);
registerSingleton(IEditSessionsContribution, EditSessionsContribution, InstantiationType.Delayed);
registerWorkbenchContribution('workbench.contrib.editSessionsFileSystemProvider', WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(EditSessionsFileSystemProvider));

const localCheckout = ContextKeyExpr.and(IsNativeContext.isEqualTo(true), WorkspaceFolderCountContext.isEqualTo(1));

registerAction2(class StoreLatestEditSessionAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.editSessions.actions.storeCurrent',
			title: localize2('editSessions.store', 'Edit Sessions: Store Working Changes Locally'),
			precondition: localCheckout,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IEditSessionsContribution).storeEditSession();
	}
});

registerAction2(class ResumeLatestEditSessionAction extends Action2 {
	constructor() {
		super({
			id: resumeEditSessionId,
			title: localize2('editSessions.resume', 'Edit Sessions: Resume Working Changes'),
			precondition: localCheckout,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor, revision?: unknown): Promise<void> {
		if (revision !== undefined && typeof revision !== 'string') throw new TypeError('Expected a saved edit session revision');
		return accessor.get(IEditSessionsContribution).resumeEditSession(revision);
	}
});

registerAction2(class ReviewEditSessionAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.editSessions.actions.showEditSessions',
			title: localize2('editSessions.review', 'Edit Sessions: Review Saved Working Changes'),
			precondition: localCheckout,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IEditSessionsContribution).reviewEditSession();
	}
});

registerAction2(class DiscardEditSessionAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.editSessions.actions.discardLocal',
			title: localize2('editSessions.discard', 'Edit Sessions: Discard Saved Working Changes'),
			precondition: localCheckout,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IEditSessionsContribution).discardEditSession();
	}
});
