import { URI } from '../../base/common/uri.js';
import type { IChatService, TurnChangeFile, TurnChangeSetSummary } from '../../workbench/services/chat/common/chatService.js';
import { createMultiDiffEditorInput, type MultiDiffEditorInput, type MultiDiffEditorInputItem } from '../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import type { IActiveSessionThread } from '../services/sessions/common/session.js';

export type TurnMultiDiffScope = 'currentTurn' | 'throughCurrentTurn' | 'previousTurn';

/** Resolves immutable Turn change sets into one composed review input. */
export async function createTurnMultiDiffEditorInput(chatService: IChatService, active: IActiveSessionThread, scope: TurnMultiDiffScope, changeSetIds?: readonly string[]): Promise<MultiDiffEditorInput> {
	const changeSets = await chatService.listTurnChanges(active.session.sessionId, active.threadId);
	const selected = changeSetIds === undefined ? selectChangeSets(changeSets, scope) : changeSetIds.map(id => {
		const changeSet = changeSets.find(candidate => candidate.changeSetId === id);
		if (!changeSet) throw new Error(`Turn change set '${id}' is no longer available.`);
		return changeSet;
	});
	const latest = selected.at(-1);
	if (!latest) throw new Error('No Turn changes are available for this selection.');
	const repositoryChangeSets = selected.filter(changeSet => changeSet.repositoryId === latest.repositoryId);
	const composed = new Map<string, ComposedTurnFile>();
	for (const changeSet of repositoryChangeSets) {
		const details = await chatService.readTurnChange(active.session.sessionId, active.threadId, changeSet.changeSetId);
		for (const file of details.files) {
			const contents = await chatService.readTurnChangeFile(active.session.sessionId, active.threadId, changeSet.changeSetId, file.path);
			if (contents.binary) continue;
			const existing = composed.get(file.path);
			if (existing) {
				existing.after = contents.after ?? '';
				existing.latestChangeSetId = changeSet.changeSetId;
				continue;
			}
			composed.set(file.path, {
				file,
				before: contents.before ?? '',
				after: contents.after ?? '',
				firstChangeSetId: changeSet.changeSetId,
				latestChangeSetId: changeSet.changeSetId,
			});
		}
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

interface ComposedTurnFile {
	readonly file: TurnChangeFile;
	readonly before: string;
	after: string;
	readonly firstChangeSetId: string;
	latestChangeSetId: string;
}

function selectChangeSets(changeSets: readonly TurnChangeSetSummary[], scope: TurnMultiDiffScope): readonly TurnChangeSetSummary[] {
	const visible = changeSets.filter(changeSet => changeSet.captureState !== 'discarded' && changeSet.statistics.files > 0);
	if (scope === 'currentTurn') return visible.slice(-1);
	if (scope === 'previousTurn') return visible.slice(-2, -1);
	return visible;
}

function turnFileInput(file: ComposedTurnFile): MultiDiffEditorInputItem {
	const encodedPath = file.file.path.split('/').map(encodeURIComponent).join('/');
	const previousPath = file.file.previousPath ?? file.file.path;
	const original = {
		resource: URI.parse(`ash-turn-diff:/${file.firstChangeSetId}/before/${encodedPath}`),
		label: `${basename(previousPath)} (Before)`,
		readOnly: true,
		initialText: file.before,
	};
	const modified = {
		resource: URI.parse(`ash-turn-diff:/${file.latestChangeSetId}/after/${encodedPath}`),
		label: `${basename(file.file.path)} (After)`,
		readOnly: true,
		initialText: file.after,
	};
	return {
		label: file.file.previousPath ? `${file.file.previousPath} → ${file.file.path}` : file.file.path,
		original,
		modified,
		goToFile: modified,
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
