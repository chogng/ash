import { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';
import { throwIfCancelled } from '../../base/common/cancellation.js';
import { raceCancellationError } from '../../base/common/async.js';
import type { IChatService, TurnChangeFile, TurnChangeSetSummary, TurnCommitPreview } from '../../workbench/services/chat/common/chatService.js';
import { createMultiDiffEditorInput, type MultiDiffEditorInput, type MultiDiffEditorInputItem } from '../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import type { IActiveSessionThread } from '../services/sessions/common/session.js';
import { createSessionFileChange } from '../services/sessions/common/session.js';

export type TurnMultiDiffScope = 'currentTurn' | 'throughCurrentTurn' | 'previousTurn';

/** The composer can lag behind the current checkpoint before review starts. */
export class ThreadChangesNotCurrentError extends Error {
	constructor() {
		super(localize('chat.changes.checkpointChanged', 'The conversation changed while loading. Open Changes again to review its current checkpoint.'));
	}
}

/** Opens precisely the checkpoint revision advertised by the composer, across all repositories. */
export async function createThreadMultiDiffEditorInput(chat: IChatService, sessionId: string, threadId: string, expectedRevision?: string): Promise<MultiDiffEditorInput> {
	const summary = await chat.readThreadChanges(sessionId, threadId);
	const changed = () => new Error(localize('chat.changes.checkpointChanged', 'The conversation changed while loading. Open Changes again to review its current checkpoint.'));
	if (expectedRevision !== undefined && summary.revision !== expectedRevision) throw new ThreadChangesNotCurrentError();
	const items: MultiDiffEditorInputItem[] = [];
	for (const repository of summary.repositories) {
		for (const file of repository.files) {
			const contents = await chat.readThreadChangeFile(sessionId, threadId, summary.revision, repository.repositoryId, file.path);
			if (contents.truncated && !contents.binary) throw new Error(localize('sessions.changes.truncated', 'This change is too large to compare in full.'));
			const resource = URI.from({
				scheme: 'ash-thread-change',
				path: `/${threadId}/${repository.repositoryId}/${file.path}`,
				query: summary.revision,
			});
			let label = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
			if (summary.repositories.length > 1) label = `${repository.repositoryId}: ${label}`;
			if (file.beforeMode && file.afterMode && file.beforeMode !== file.afterMode) {
				label = localize('sessions.changes.modeLabel', '{0} (mode {1} → {2})', label, file.beforeMode, file.afterMode);
			}
			items.push({
				label,
				binary: contents.binary,
				original: {
					resource: resource.with({ fragment: 'before' }),
					initialText: contents.before ?? '',
					readOnly: true,
				},
				modified: {
					resource: resource.with({ fragment: 'after' }),
					initialText: contents.after ?? '',
					readOnly: true,
				},
			});
		}
	}
	// A history move between the final file read and publication must not publish a stale review.
	if ((await chat.readThreadChanges(sessionId, threadId)).revision !== summary.revision) throw changed();
	const label = localize('chat.changes.conversationTitle', 'Conversation Changes');
	return createMultiDiffEditorInput(
		URI.from({ scheme: 'ash-multi-diff', path: `/conversation/${sessionId}/${threadId}`, query: summary.revision }),
		items,
		summary.warnings.length ? localize('sessions.changes.previewWarnings', '{0} — Review: {1}', label, summary.warnings.join('; ')) : label,
		{ kind: 'snapshot', label },
	);
}

/** Resolves immutable Turn change sets into one composed review input. */
export async function createTurnMultiDiffEditorInput(
	chatService: IChatService,
	active: IActiveSessionThread,
	scope: TurnMultiDiffScope,
	changeSetIds?: readonly string[],
	signal?: AbortSignal,
): Promise<MultiDiffEditorInput> {
	const checkCancelled = (): void => {
		if (signal) {
			throwIfCancelled(signal);
		}
	};
	const read = <T>(promise: Promise<T>): Promise<T> => (signal ? raceCancellationError(promise, signal) : promise);
	checkCancelled();
	const changeSets = await read(chatService.listTurnChanges(active.session.sessionId, active.threadId));
	checkCancelled();
	const selected =
		changeSetIds === undefined
			? selectChangeSets(changeSets, scope)
			: changeSetIds.map(id => {
					const changeSet = changeSets.find(candidate => candidate.changeSetId === id);
					if (!changeSet) throw new Error(`Turn change set '${id}' is no longer available.`);
					return changeSet;
				});
	const latest = selected.at(-1);
	if (!latest) throw new Error('No Turn changes are available for this selection.');
	const repositoryChangeSets = selected.filter(changeSet => changeSet.repositoryId === latest.repositoryId);
	const composed = new Map<string, ComposedTurnFile>();
	for (const changeSet of repositoryChangeSets) {
		checkCancelled();
		const details = await read(chatService.readTurnChange(active.session.sessionId, active.threadId, changeSet.changeSetId));
		checkCancelled();
		for (const file of details.files) {
			const contents = await read(chatService.readTurnChangeFile(active.session.sessionId, active.threadId, changeSet.changeSetId, file.path));
			checkCancelled();
			if (contents.truncated && !contents.binary) throw new Error(localize('sessions.changes.truncated', 'This change is too large to compare in full.'));
			const existing = composed.get(file.path);
			if (existing) {
				existing.after = contents.after ?? '';
				existing.binary ||= contents.binary;
				existing.latestSummary = details.summary;
				continue;
			}
			composed.set(file.path, {
				file,
				binary: contents.binary,
				before: contents.before ?? '',
				after: contents.after ?? '',
				firstSummary: details.summary,
				latestSummary: details.summary,
			});
		}
		const current = await read(chatService.readTurnChange(active.session.sessionId, active.threadId, changeSet.changeSetId));
		checkCancelled();
		if (current.summary.revision !== details.summary.revision || current.summary.captureState === 'discarded') {
			throw new Error(localize('sessions.changes.captureChanged', 'This Turn capture changed while loading. Reopen its changes to review the latest revision.'));
		}
	}
	const items = [...composed.values()].map(turnFileInput);
	const ids = repositoryChangeSets.map(changeSet => changeSet.changeSetId);
	const source = URI.parse(
		`ash-multi-diff:/turn/${scope}?session=${encodeURIComponent(active.session.sessionId)}&thread=${encodeURIComponent(active.threadId)}&changes=${encodeURIComponent(ids.join(','))}`,
	);
	return createMultiDiffEditorInput(source, items, turnScopeLabel(scope), {
		kind: 'external',
		providerId: 'sessions.turn',
		label: turnScopeLabel(scope),
		repositoryId: latest.repositoryId,
		branchName: latest.targetBranch,
	});
}

interface ComposedTurnFile {
	readonly file: TurnChangeFile;
	binary: boolean;
	readonly before: string;
	after: string;
	readonly firstSummary: TurnChangeSetSummary;
	latestSummary: TurnChangeSetSummary;
}

function selectChangeSets(changeSets: readonly TurnChangeSetSummary[], scope: TurnMultiDiffScope): readonly TurnChangeSetSummary[] {
	const visible = changeSets.filter(changeSet => changeSet.captureState !== 'discarded' && changeSet.statistics.files > 0);
	if (scope === 'currentTurn') return visible.slice(-1);
	if (scope === 'previousTurn') return visible.slice(-2, -1);
	return visible;
}

function turnFileInput(file: ComposedTurnFile): MultiDiffEditorInputItem {
	const first = createSessionFileChange(file.firstSummary, file.file);
	const latest = createSessionFileChange(file.latestSummary, file.file);
	const previousPath = file.file.previousPath ?? file.file.path;
	const original = {
		resource: first.originalUri,
		label: `${basename(previousPath)} (Before)`,
		readOnly: true,
		initialText: file.before,
	};
	const modified = {
		resource: latest.modifiedUri,
		label: `${basename(file.file.path)} (After)`,
		readOnly: true,
		initialText: file.after,
	};
	return {
		binary: file.binary,
		label: file.file.previousPath ? `${file.file.previousPath} → ${file.file.path}` : file.file.path,
		original,
		modified,
		goToFile: modified,
		contextKeys: {
			'sessions.changesCanReview': file.latestSummary.captureState !== 'discarded',
			'sessions.changesCanPreview':
				file.latestSummary.captureState === 'sealed' &&
				!file.latestSummary.committedPaths.includes(file.file.path) &&
				file.latestSummary.commitState !== 'queued' &&
				file.latestSummary.commitState !== 'committing',
		},
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
	const items = await Promise.all(
		preview.files.map(async file => {
			const contents = await chat.readTurnCommitFile(sessionId, threadId, preview.commitId, file.path);
			if (contents.truncated && !contents.binary) {
				throw new Error(localize('sessions.changes.truncated', 'This change is too large to compare in full.'));
			}
			const path = file.path.split('/').map(encodeURIComponent).join('/');
			const resource = URI.parse(`ash-turn-commit:/${encodeURIComponent(preview.commitId)}/${path}`);
			const original = {
				resource: resource.with({ query: 'target' }),
				initialText: contents.before ?? '',
				readOnly: true,
			};
			const modified = {
				resource: resource.with({ query: 'commit' }),
				initialText: contents.after ?? '',
				readOnly: true,
			};
			let label = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
			if (contents.binary) {
				label = localize('sessions.changes.binaryLabel', '{0} (binary)', label);
			}
			if (file.beforeMode && file.afterMode && file.beforeMode !== file.afterMode) {
				label = localize('sessions.changes.modeLabel', '{0} (mode {1} → {2})', label, file.beforeMode, file.afterMode);
			}
			return { label, original, modified, binary: contents.binary, goToFile: modified };
		}),
	);
	const resource = URI.parse(`ash-multi-diff:/turn-commit/${encodeURIComponent(preview.commitId)}?session=${encodeURIComponent(sessionId)}&thread=${encodeURIComponent(threadId)}`);
	const title = localize('sessions.changes.commitPreview', '{0} files to commit to {1}: {2}', preview.files.length, preview.targetBranch, preview.message);
	const label = preview.warnings.length ? localize('sessions.changes.previewWarnings', '{0} — Review: {1}', title, preview.warnings.join('; ')) : title;
	return createMultiDiffEditorInput(resource, items, label, {
		kind: 'external',
		providerId: 'sessions.turnCommit',
		label,
		branchName: preview.targetBranch,
	});
}
