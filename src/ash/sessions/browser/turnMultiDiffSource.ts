import { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';
import { throwIfCancelled } from '../../base/common/cancellation.js';
import { raceCancellationError } from '../../base/common/async.js';
import { equals } from '../../base/common/objects.js';
import type { IChatService, TurnChangeFile, TurnChangeFileContents, TurnChangeSetSummary, TurnCommitPreview } from '../../workbench/services/chat/common/chatService.js';
import { createMultiDiffEditorInput, type MultiDiffEditorInput, type MultiDiffEditorInputItem } from '../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import type { IActiveSessionThread, ISessionFileChange } from '../services/sessions/common/session.js';
import { createSessionFileChange } from '../services/sessions/common/session.js';

export type TurnMultiDiffScope = 'currentTurn' | 'throughCurrentTurn' | 'previousTurn';

/** Resolves immutable Turn change sets into one composed review input. */
export async function createTurnMultiDiffEditorInput(
	chatService: IChatService,
	active: { readonly session: Pick<IActiveSessionThread['session'], 'sessionId'>; readonly threadId: string; },
	scope: TurnMultiDiffScope | { readonly turnId: string; },
	changeSetIds?: readonly string[],
	signal?: AbortSignal,
): Promise<MultiDiffEditorInput> {
	const checkCancelled = (): void => { if (signal) { throwIfCancelled(signal); } };
	const read = <T>(promise: Promise<T>): Promise<T> => signal ? raceCancellationError(promise, signal) : promise;
	checkCancelled();
	const changeSets = await read(chatService.listTurnChanges(active.session.sessionId, active.threadId));
	checkCancelled();
	const exactTurn = typeof scope === 'string' ? undefined : scope.turnId;
	const selected = typeof scope !== 'string' ? sealedTurnChanges(changeSets, scope.turnId)
		: changeSetIds === undefined ? selectChangeSets(changeSets, scope) : changeSetIds.map(id => {
			const changeSet = changeSets.find(candidate => candidate.changeSetId === id);
			if (!changeSet) throw new Error(`Turn change set '${id}' is no longer available.`);
			return changeSet;
		});
	const latest = selected.at(-1);
	if (!latest) throw new Error(exactTurn === undefined ? 'No Turn changes are available for this selection.' : localize('chat.turnChanges.unavailable', 'This turn’s file changes are no longer available.'));
	const repositoryChangeSets = exactTurn === undefined ? selected.filter(changeSet => changeSet.repositoryId === latest.repositoryId) : selected;
	const composed = new Map<string, ComposedTurnFile>();
	for (const changeSet of repositoryChangeSets) {
		const snapshot = await readTurnChangeSnapshot(chatService, changeSet, { signal });
		checkCancelled();
		for (const { change, contents } of snapshot.files) {
			const identity = JSON.stringify([changeSet.repositoryId, change.file.path]);
			const existing = composed.get(identity);
			if (existing) {
				existing.modified = turnSnapshotSide(change.modifiedUri, contents.after, existing.modified.label);
				existing.binary ||= contents.binary;
				existing.latestSummary = snapshot.summary;
				continue;
			}
			composed.set(identity, {
				file: change.file,
				binary: contents.binary,
				original: turnSnapshotSide(change.originalUri, contents.before, `${basename(change.file.previousPath ?? change.file.path)} (Before)`),
				modified: turnSnapshotSide(change.modifiedUri, contents.after, `${basename(change.file.path)} (After)`),
				latestSummary: snapshot.summary,
			});
		}
		await assertTurnCaptureCurrent(chatService, snapshot.summary, signal);
	}
	if (typeof scope !== 'string') {
		const current = await read(chatService.listTurnChanges(active.session.sessionId, active.threadId));
		checkCancelled();
		assertCaptureRevisions(selected, sealedTurnChanges(current, scope.turnId));
		const label = localize('chat.turnChanges.title', 'Turn File Changes');
		const source = URI.from({
			scheme: 'ash-multi-diff', path: `/turn/${scope.turnId}`, query: new URLSearchParams({
				session: active.session.sessionId, thread: active.threadId, captures: JSON.stringify(selected.map(({ changeSetId, revision }) => [changeSetId, revision])),
			}).toString()
		});
		const multipleRepositories = new Set(selected.map(changeSet => changeSet.repositoryId)).size > 1;
		const items = [...composed.values()].map(file => {
			const item = turnFileInput(file);
			return { ...item, label: multipleRepositories ? `${file.latestSummary.repositoryId}: ${item.label}` : item.label, contextKeys: undefined };
		});
		return createMultiDiffEditorInput(source, items, label, { kind: 'snapshot', label });
	}
	const items = [...composed.values()].map(turnFileInput);
	const ids = repositoryChangeSets.map(changeSet => changeSet.changeSetId);
	const source = URI.parse(`ash-multi-diff:/turn/${scope}?session=${encodeURIComponent(active.session.sessionId)}&thread=${encodeURIComponent(active.threadId)}&changes=${encodeURIComponent(ids.join(','))}`);
	return createMultiDiffEditorInput(source, items, turnScopeLabel(scope), {
		kind: 'external',
		providerId: 'sessions.turn',
		label: turnScopeLabel(scope),
		repositoryId: latest.repositoryId,
		branchName: latest.targetBranch,
	});
}

/** Opens a selection from the Changes editor with that selection's review capabilities. */
export async function createTurnChangesSelectionInput(
	chat: IChatService,
	resource: URI,
	label: string,
	changes: readonly { readonly change: ISessionFileChange; readonly canReview: boolean; }[],
	signal: AbortSignal,
): Promise<MultiDiffEditorInput> {
	const items = await Promise.all(changes.map(async ({ change, canReview }): Promise<MultiDiffEditorInputItem> => {
		const contents = await readTurnFileContents(chat, change, signal);
		return {
			label: change.file.path, binary: contents.binary,
			contextKeys: turnReviewContextKeys(change.summary, change.file.path, canReview),
			original: turnSnapshotSide(change.originalUri, contents.before),
			modified: turnSnapshotSide(change.modifiedUri, contents.after),
		};
	}));
	const captures = new Map(changes.map(({ change }) => [JSON.stringify([change.summary.sessionId, change.summary.threadId, change.summary.changeSetId]), change.summary]));
	await Promise.all([...captures.values()].map(summary => assertTurnCaptureCurrent(chat, summary, signal)));
	return createMultiDiffEditorInput(resource, items, label, { kind: 'snapshot', label });
}

function sealedTurnChanges(changeSets: readonly TurnChangeSetSummary[], turnId: string): readonly TurnChangeSetSummary[] {
	return changeSets.filter(changeSet => changeSet.turnId === turnId && changeSet.captureState === 'sealed' && changeSet.statistics.files > 0);
}

async function readTurnChangeSnapshot(
	chat: IChatService,
	capture: TurnChangeSetSummary,
	{ signal, expectedRevision }: { readonly signal?: AbortSignal; readonly expectedRevision?: number; },
) {
	const { sessionId, threadId, changeSetId } = capture;
	const read = <T>(promise: Promise<T>): Promise<T> => signal ? raceCancellationError(promise, signal) : promise;
	if (signal) throwIfCancelled(signal);
	const details = await read(chat.readTurnChange(sessionId, threadId, changeSetId));
	if (details.summary.captureState === 'discarded' || expectedRevision !== undefined && details.summary.revision !== expectedRevision) {
		throw captureChanged();
	}
	const files: { change: ISessionFileChange; contents: TurnChangeFileContents; }[] = [];
	for (const file of details.files) {
		const change = createSessionFileChange(details.summary, file);
		files.push({ change, contents: await readTurnFileContents(chat, change, signal) });
	}
	return { summary: details.summary, files };
}

async function readTurnFileContents(chat: IChatService, change: ISessionFileChange, signal?: AbortSignal): Promise<TurnChangeFileContents> {
	if (signal) throwIfCancelled(signal);
	const { sessionId, threadId, changeSetId } = change.summary;
	const pending = chat.readTurnChangeFile(sessionId, threadId, changeSetId, change.file.path);
	const contents = await (signal ? raceCancellationError(pending, signal) : pending);
	if (signal) throwIfCancelled(signal);
	if (contents.truncated && !contents.binary) throw new Error(localize('sessions.changes.truncated', 'This change is too large to compare in full.'));
	return contents;
}

async function assertTurnCaptureCurrent(chat: IChatService, summary: TurnChangeSetSummary, signal?: AbortSignal): Promise<void> {
	if (signal) throwIfCancelled(signal);
	const pending = chat.readTurnChange(summary.sessionId, summary.threadId, summary.changeSetId);
	const current = await (signal ? raceCancellationError(pending, signal) : pending);
	if (signal) throwIfCancelled(signal);
	// File reads target a live capture. Keep their contents paired with the selected revision.
	if (current.summary.revision !== summary.revision || current.summary.captureState === 'discarded') throw captureChanged();
}

function turnSnapshotSide(resource: URI, text: string | undefined, label?: string) {
	return { resource, ...(label === undefined ? {} : { label }), readOnly: true, initialText: text ?? '' };
}

function captureRevisions(changes: readonly TurnChangeSetSummary[]) {
	return changes.map(change => [change.changeSetId, change.revision]).sort();
}

function assertCaptureRevisions(expected: readonly TurnChangeSetSummary[], current: readonly TurnChangeSetSummary[]): void {
	if (!equals(captureRevisions(expected), captureRevisions(current))) throw captureChanged();
}

function captureChanged(): Error {
	return new Error(localize('sessions.changes.captureChanged', 'This Turn capture changed while loading. Reopen its changes to review the latest revision.'));
}

interface ComposedTurnFile {
	readonly file: TurnChangeFile;
	binary: boolean;
	readonly original: ReturnType<typeof turnSnapshotSide>;
	modified: ReturnType<typeof turnSnapshotSide>;
	latestSummary: TurnChangeSetSummary;
}

function selectChangeSets(changeSets: readonly TurnChangeSetSummary[], scope: TurnMultiDiffScope): readonly TurnChangeSetSummary[] {
	const visible = changeSets.filter(changeSet => changeSet.captureState !== 'discarded' && changeSet.statistics.files > 0);
	if (scope === 'currentTurn') return visible.slice(-1);
	if (scope === 'previousTurn') return visible.slice(-2, -1);
	return visible;
}

function turnFileInput(file: ComposedTurnFile): MultiDiffEditorInputItem {
	return {
		binary: file.binary,
		label: file.file.previousPath ? `${file.file.previousPath} → ${file.file.path}` : file.file.path,
		original: file.original,
		modified: file.modified,
		goToFile: file.modified,
		contextKeys: turnReviewContextKeys(file.latestSummary, file.file.path, file.latestSummary.captureState !== 'discarded'),
	};
}

function turnReviewContextKeys(summary: TurnChangeSetSummary, path: string, canReview: boolean): Readonly<Record<string, boolean>> {
	return {
		'sessions.changesCanReview': canReview,
		'sessions.changesCanPreview': summary.captureState === 'sealed' && !summary.committedPaths.includes(path)
			&& summary.commitState !== 'queued' && summary.commitState !== 'committing',
	};
}

function turnScopeLabel(scope: TurnMultiDiffScope): string {
	if (scope === 'currentTurn') return 'Current Turn';
	if (scope === 'previousTurn') return 'Previous Turn';
	return 'Changes Through Current Turn';
}

function basename(path: string): string {
	return path.replaceAll('\\', '/').split('/').at(-1) ?? path;
}

/** Reviews the exact tree prepared by the backend, including binary and mode-only changes. */
export async function createTurnCommitPreviewInput(chat: IChatService, sessionId: string, threadId: string, preview: TurnCommitPreview): Promise<MultiDiffEditorInput> {
	const items = await Promise.all(preview.files.map(async file => {
		const contents = await chat.readTurnCommitFile(sessionId, threadId, preview.commitId, file.path);
		if (contents.truncated && !contents.binary) { throw new Error(localize('sessions.changes.truncated', 'This change is too large to compare in full.')); }
		const path = file.path.split('/').map(encodeURIComponent).join('/');
		const resource = URI.parse(`ash-turn-commit:/${encodeURIComponent(preview.commitId)}/${path}`);
		const original = { resource: resource.with({ query: 'target' }), initialText: contents.before ?? '', readOnly: true };
		const modified = { resource: resource.with({ query: 'commit' }), initialText: contents.after ?? '', readOnly: true };
		let label = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
		if (contents.binary) { label = localize('sessions.changes.binaryLabel', '{0} (binary)', label); }
		if (file.beforeMode && file.afterMode && file.beforeMode !== file.afterMode) {
			label = localize('sessions.changes.modeLabel', '{0} (mode {1} → {2})', label, file.beforeMode, file.afterMode);
		}
		return { label, original, modified, binary: contents.binary, goToFile: modified };
	}));
	const resource = URI.parse(`ash-multi-diff:/turn-commit/${encodeURIComponent(preview.commitId)}?session=${encodeURIComponent(sessionId)}&thread=${encodeURIComponent(threadId)}`);
	const title = localize('sessions.changes.commitPreview', '{0} files to commit to {1}: {2}', preview.files.length, preview.targetBranch, preview.message);
	const label = preview.warnings.length ? localize('sessions.changes.previewWarnings', '{0} — Review: {1}', title, preview.warnings.join('; ')) : title;
	return createMultiDiffEditorInput(resource, items, label, { kind: 'external', providerId: 'sessions.turnCommit', label, branchName: preview.targetBranch });
}

export interface TurnCaptureTarget {
	readonly sessionId: string;
	readonly threadId: string;
	readonly turnId: string;
}

export function completedTurnChangeSets(changes: readonly TurnChangeSetSummary[], target: TurnCaptureTarget): readonly TurnChangeSetSummary[] {
	const selected = changes.filter(change => change.sessionId === target.sessionId && change.threadId === target.threadId && change.turnId === target.turnId);
	return selected.every(change => change.captureState === 'sealed' && change.terminalState === 'completed') ? selected : [];
}

async function readCompletedTurnChanges(chat: IChatService, target: TurnCaptureTarget) {
	return completedTurnChangeSets(await chat.listTurnChanges(target.sessionId, target.threadId), target);
}

/** Both results need a completed capture of the same set of repositories, including unchanged repositories. */
export async function readComparableTurnChanges(chat: IChatService, original: TurnCaptureTarget, alternate: TurnCaptureTarget) {
	const captures = await Promise.all([readCompletedTurnChanges(chat, original), readCompletedTurnChanges(chat, alternate)]);
	const [before, after] = captures;
	const repositories = new Set(before.map(change => change.repositoryId));
	if (repositories.size > 0 && repositories.size === before.length && after.length === before.length
		&& after.every(change => repositories.delete(change.repositoryId))) return captures;
	return undefined;
}

interface FileSnapshot {
	readonly resource: URI;
	readonly text: string | undefined;
	readonly mode: string | undefined;
	readonly binary: boolean;
}

interface VersionFile {
	readonly path: string;
	readonly repositoryId: string;
	before?: FileSnapshot;
	after?: FileSnapshot;
}

/** Compares the final file snapshots of two Turns that ran from the same checkpoint. */
export async function createTurnResultComparisonInput(
	chat: IChatService,
	pair: { readonly original: TurnCaptureTarget; readonly alternate: TurnCaptureTarget; },
): Promise<MultiDiffEditorInput> {
	const captures = await readComparableTurnChanges(chat, pair.original, pair.alternate);
	if (!captures) throw captureChanged();
	const [original, alternate] = captures;
	const [leftFiles, rightFiles] = await Promise.all([readResultFiles(chat, original), readResultFiles(chat, alternate)]);
	const current = await Promise.all([readCompletedTurnChanges(chat, pair.original), readCompletedTurnChanges(chat, pair.alternate)]);
	assertCaptureRevisions(original, current[0]);
	assertCaptureRevisions(alternate, current[1]);

	const items: MultiDiffEditorInputItem[] = [];
	const title = localize('sessions.requestVersions.compare', 'Compare results');
	const originalLabel = localize('sessions.requestVersions.original', 'Original run');
	const alternateLabel = localize('sessions.requestVersions.alternate', 'Another version');
	const resource = URI.from({
		scheme: 'ash-multi-diff',
		path: '/request-versions',
		query: JSON.stringify([pair.original, pair.alternate, captureRevisions(original), captureRevisions(alternate)]),
	});
	for (const id of new Set([...leftFiles.keys(), ...rightFiles.keys()])) {
		const left = leftFiles.get(id);
		const right = rightFiles.get(id);
		const file = (left ?? right)!;
		// A path untouched by one run keeps the common checkpoint's content.
		const before = left ? left.after : right?.before;
		const after = right ? right.after : left?.before;
		if (!before && !after) continue;
		const binary = before?.binary === true || after?.binary === true;
		if (before && after && !binary && before.mode === after.mode && before.text === after.text) continue;
		const label = original.length > 1 ? `${file.repositoryId}: ${file.path}` : file.path;
		const missing = resource.with({ path: `/request-versions/${file.path}`, fragment: id });
		items.push({
			id, label: before && after && before.mode && after.mode && before.mode !== after.mode
				? localize('sessions.changes.modeLabel', '{0} (mode {1} → {2})', label, before.mode, after.mode) : label,
			binary,
			original: turnSnapshotSide(before?.resource ?? missing, before?.text, originalLabel),
			modified: turnSnapshotSide(after?.resource ?? missing, after?.text, alternateLabel),
		});
	}
	return createMultiDiffEditorInput(resource, items, title, { kind: 'snapshot', label: title });
}

async function readResultFiles(chat: IChatService, captures: readonly TurnChangeSetSummary[]): Promise<Map<string, VersionFile>> {
	const result = new Map<string, VersionFile>();
	for (const capture of captures) {
		const { repositoryId } = capture;
		const snapshot = await readTurnChangeSnapshot(chat, capture, { expectedRevision: capture.revision });
		const entry = (path: string): VersionFile => {
			const key = JSON.stringify([repositoryId, path]);
			let file = result.get(key);
			if (!file) result.set(key, file = { path, repositoryId });
			return file;
		};
		for (const { change: { file, originalUri, modifiedUri }, contents } of snapshot.files) {
			if (file.kind !== 'added') {
				entry(file.previousPath ?? file.path).before = { resource: originalUri, text: contents.before, mode: file.beforeMode, binary: contents.binary };
			}
			if (file.kind !== 'deleted') {
				entry(file.path).after = { resource: modifiedUri, text: contents.after, mode: file.afterMode, binary: contents.binary };
			}
		}
	}
	return result;
}
