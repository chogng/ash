import { URI } from '../../../../base/common/uri.js';
import type { IActiveSessionThread } from '../../../../sessions/services/sessions/common/session.js';
import type { IChatService, TurnChangeFile, TurnChangeSetSummary } from '../../../services/chat/common/chatService.js';
import { createMultiDiffEditorInput, type MultiDiffEditorInput, type MultiDiffEditorInputItem, type MultiDiffEditorSource } from './multiDiffEditorInput.js';

export type TurnMultiDiffScope = Extract<MultiDiffEditorSource, { readonly kind: 'turn' }>['scope'];

/** Resolves immutable Turn change sets into one composed review input. */
export async function createTurnMultiDiffEditorInput(chatService: IChatService, active: IActiveSessionThread, scope: TurnMultiDiffScope): Promise<MultiDiffEditorInput> {
	const changeSets = await chatService.listTurnChanges(active.session.sessionId, active.threadId);
	const selected = selectChangeSets(changeSets, scope);
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
		kind: 'turn',
		sessionId: active.session.sessionId,
		threadId: active.threadId,
		changeSetIds: ids,
		repositoryId: latest.repositoryId,
		targetBranch: latest.targetBranch,
		scope,
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
