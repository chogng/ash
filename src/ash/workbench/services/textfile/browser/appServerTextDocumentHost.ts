import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, toDisposable, type IDisposable, type IReference } from '../../../../base/common/lifecycle.js';
import { isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import type { LanguageWorkspaceEdit, LanguageWorkspaceEditEntry } from '../../../../editor/common/languages.js';
import { ITextModelService, type ITextModelService as ITextModelServiceContract, type IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { AppServerProtocolClient } from '../../../../platform/app-server/browser/appServerProtocolClient.js';
import { APP_SERVER_SERVER_REQUESTS, type TextDocumentApplyParams, type TextDocumentApplyResult, type TextDocumentReadResult, type TextDocumentListResult } from '../../../../../../.build/protocol/typescript/index.js';
import { FileNotFoundError } from '../../../../platform/files/common/files.js';
import { WorkspaceEditConflictError } from '../../../../editor/browser/services/bulkEditService.js';
import { IWorkingCopyService, type IWorkingCopyService as IWorkingCopyServiceContract } from '../../workingCopy/common/workingCopyService.js';
import type { ChatEditSource, ChatEditOutcome } from '../../chat/common/chatService.js';

interface DocumentEditReview {
	applyEdits(edit: LanguageWorkspaceEdit, signal: AbortSignal, source: ChatEditSource): Promise<{ readonly isApplied: boolean; }>;
	finishTurn(source: ChatEditSource, outcome: ChatEditOutcome): Promise<void>;
}

interface DocumentSnapshot extends IDisposable {
	readonly reference: IReference<IResolvedTextEditorModel>;
	readonly resource: URI;
	readonly version: number;
}

/** Holds protocol snapshot leases; document state, undo and persistence stay in editor services. */
export class AppServerTextDocumentHost extends Disposable {
	private readonly snapshots = this._register(new DisposableMap<string, DocumentSnapshot>());

	constructor(client: AppServerProtocolClient, private readonly review: DocumentEditReview, @ITextModelService private readonly models: ITextModelServiceContract, @IWorkingCopyService private readonly workingCopies: IWorkingCopyServiceContract) {
		super();
		this._register(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['textDocument/read'], (params, context) => this.read(params.path, context.signal)));
		this._register(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['textDocument/list'], (params, context) => this.list(params.root, context.signal)));
		this._register(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['textDocument/apply'], (params, context) => this.apply(params, context.signal)));
		this._register(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['textDocument/release'], params => {
			for (const snapshot of params.snapshots) { this.snapshots.deleteAndDispose(snapshot); }
			return null;
		}));
		this._register(client.onStateChange(state => {
			if (state !== 'ready') { this.snapshots.clearAndDisposeAll(); }
		}));
		this._register(client.onNotification(notification => {
			if (notification.method === 'textDocument/turnFinished') {
				void this.review.finishTurn({ threadId: notification.params.threadId, turnId: notification.params.turnId }, notification.params.outcome).catch(onUnexpectedError);
			}
		}));
	}

	private list(path: string, signal: AbortSignal): TextDocumentListResult {
		throwIfCancelled(signal);
		const root = documentResource(path);
		const documents = this.workingCopies.getAll()
			.filter(copy => copy.backupKind === 'text' && copy.isDirty && extUriBiasedIgnorePathCase.isEqualOrParent(copy.resource, root))
			.map(copy => ({ relativePath: copy.resource.path.slice(root.path.replace(/\/$/u, '').length).replace(/^\//u, ''), text: copy.backup() }));
		return { kind: 'documents', documents };
	}

	private async read(path: string, signal: AbortSignal): Promise<TextDocumentReadResult> {
		let reference: IReference<IResolvedTextEditorModel> | undefined;
		try {
			throwIfCancelled(signal);
			const resource = documentResource(path);
			reference = await this.models.createModelReference(resource);
			// Resolution is not cancellable. Closing must also release a late result.
			throwIfCancelled(signal);
			this.assertNotDisposed();
			for (const [id, snapshot] of this.snapshots) {
				if (snapshot.resource.toString() === resource.toString()) { this.snapshots.deleteAndDispose(id); }
			}
			if (this.snapshots.size >= 128) { throw new Error('Document snapshot limit reached'); }
			const model = reference.object.textEditorModel;
			const id = crypto.randomUUID();
			const ownedReference = reference;
			this.snapshots.set(id, { reference: ownedReference, resource, version: model.getVersionId(), ...toDisposable(() => ownedReference.dispose()) });
			reference = undefined;
			return { kind: 'document', snapshot: id, text: model.getValue() };
		} catch (error) {
			if (isCancellationError(error)) { throw error; }
			if (error instanceof FileNotFoundError) { return { kind: 'notFound' }; }
			return { kind: 'failed', message: String(error) };
		} finally {
			reference?.dispose();
		}
	}

	private async apply(params: TextDocumentApplyParams, signal: AbortSignal): Promise<TextDocumentApplyResult> {
		const consumed = params.changes.flatMap(change => change.kind === 'create' ? [] : [change.snapshot]);
		let applied = false;
		try {
			throwIfCancelled(signal);
			const entries: LanguageWorkspaceEditEntry[] = [];
			const resources = new Set<string>();
			for (const change of params.changes) {
				if (change.kind === 'create') {
					const resource = documentResource(change.path);
					claimResource(resources, resource);
					entries.push({ kind: 'create', resource, contents: change.text, existing: 'error' });
					continue;
				}
				const snapshot = this.snapshots.get(change.snapshot);
				if (!snapshot || snapshot.reference.object.textEditorModel.getVersionId() !== snapshot.version) { return { kind: 'conflict' }; }
				claimResource(resources, snapshot.resource);
				const model = snapshot.reference.object.textEditorModel;
				// Check the captured version again inside the transaction after asynchronous preflight.
				entries.push({ kind: 'textDocument', resource: snapshot.resource, version: snapshot.version, edits: [{ range: model.getFullModelRange(), text: change.kind === 'delete' ? model.getValue() : change.text }] });
				if (change.kind === 'delete') { entries.push({ kind: 'delete', resource: snapshot.resource, missing: 'error', mode: 'fileOrEmptyDirectory' }); }
				if (change.kind === 'move') {
					const target = documentResource(change.target);
					claimResource(resources, target);
					entries.push({ kind: 'rename', source: snapshot.resource, target, existing: 'error' });
				}
			}
			const result = await this.review.applyEdits({ entries }, signal, { threadId: params.threadId, turnId: params.turnId });
			if (!result.isApplied) { return { kind: 'cancelled' }; }
			applied = true;
			// File tools participate in executable Agent tasks. Their success means the next
			// process can read the edits; save retains the model and its existing undo history.
			for (const key of resources) {
				for (const copy of this.workingCopies.get(URI.parse(key))) {
					if (copy.isDirty) { await copy.save(signal); }
				}
			}
			return { kind: 'applied' };
		} catch (error) {
			if (applied) { return { kind: 'outcomeUnknown', message: String(error) }; }
			if (error instanceof WorkspaceEditConflictError) { return { kind: 'conflict' }; }
			if (error instanceof AggregateError) { return { kind: 'outcomeUnknown', message: String(error) }; }
			if (isCancellationError(error)) { return { kind: 'cancelled' }; }
			return { kind: 'failed', message: String(error) };
		} finally {
			for (const snapshot of consumed) { this.snapshots.deleteAndDispose(snapshot); }
		}
	}
}

function documentResource(path: string): URI {
	if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/u.test(path)) { throw new TypeError('Document path must be absolute'); }
	return URI.file(path);
}

function claimResource(resources: Set<string>, resource: URI): void {
	const key = resource.toString();
	if (resources.has(key)) { throw new TypeError('Document transaction repeats a resource'); }
	resources.add(key);
}
