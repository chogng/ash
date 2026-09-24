import { Disposable } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { CHAT_VIEW_ID } from '../../chat/common/chat.js';
import { ChatViewPane } from '../../chat/browser/view/chatViewPane.js';
import { IChatContextPickService, type ChatContextAttachment, type ChatContextPick } from '../../../services/chat/common/chatContextService.js';
import type { GitCommitChange, GitCommitFile, GitCommitFileContent, GitCommitSummary, IGitService } from '../../../services/git/common/gitService.js';
import { IGitService as GitService } from '../../../services/git/common/gitService.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';

const HistoryLimit = 100;
const MaxFiles = 40;
const MaxFileCharacters = 64 * 1024;
const MaxContextCharacters = 512 * 1024;

/** Registers Git history as a searchable, lazily resolved Chat context source. */
export class ScmHistoryChatContextContribution extends Disposable {
	constructor(contextPickService: IChatContextPickService, gitService: IGitService) {
		super();
		this._register(contextPickService.registerPicker({
			id: 'scm.history',
			label: 'Source Control',
			isEnabled: async () => gitService.status().then(() => true, () => false),
			providePicks: query => historyPicks(gitService, query),
		}));
	}
}

export function createCommitChatAttachment(gitService: IGitService, commit: GitCommitSummary): ChatContextAttachment {
	return {
		id: `${commit.repositoryId}:${commit.objectId}`,
		kind: 'scmHistoryItem',
		name: `${commit.objectId.slice(0, 7)} · ${commit.subject}`,
		resolve: () => resolveCommitContext(gitService, commit),
	};
}

export function createCommitChangeChatAttachment(gitService: IGitService, commit: GitCommitSummary, change: GitCommitChange): ChatContextAttachment {
	return {
		id: `${commit.repositoryId}:${commit.objectId}:${change.path}`,
		kind: 'scmHistoryItemChange',
		name: change.path,
		resolve: async () => ({
			name: `Git change ${commit.objectId.slice(0, 7)} · ${change.path}`,
			content: formatFileChange(commit, change, await gitService.commitFile(commit.objectId, change.path, commit.repositoryId)),
		}),
	};
}

async function historyPicks(gitService: IGitService, rawQuery: string): Promise<readonly ChatContextPick[]> {
	const query = rawQuery.trim().toLocaleLowerCase();
	const page = await gitService.graph({ limit: HistoryLimit });
	return page.commits
		.filter(commit => !query || commit.subject.toLocaleLowerCase().includes(query) || commit.objectId.toLocaleLowerCase().includes(query))
		.map(commit => ({
			label: commit.subject,
			description: commit.objectId.slice(0, 7),
			detail: new Date(commit.timestampSeconds * 1_000).toLocaleString(),
			attachment: createCommitChatAttachment(gitService, commit),
		}));
}

async function resolveCommitContext(gitService: IGitService, commit: GitCommitSummary): Promise<{ readonly name: string; readonly content: string }> {
	const result = await gitService.commitChanges(commit.objectId, commit.repositoryId);
	const selected = result.changes.slice(0, MaxFiles);
	const files = await Promise.all(selected.map(async change => ({
		change,
		file: await gitService.commitFile(commit.objectId, change.path, commit.repositoryId),
	})));
	const sections = [
		`Commit: ${commit.objectId}`,
		`Subject: ${commit.subject}`,
		`Parents: ${commit.parentObjectIds.join(', ') || '(root commit)'}`,
		`Changed files: ${result.changes.length}`,
		...files.map(({ change, file }) => formatFileChange(commit, change, file)),
	];
	if (result.changes.length > selected.length) {
		sections.push(`[${result.changes.length - selected.length} additional files omitted]`);
	}
	return {
		name: `Git commit ${commit.objectId.slice(0, 7)} · ${commit.subject}`,
		content: truncate(sections.join('\n\n'), MaxContextCharacters, 'commit context'),
	};
}

function formatFileChange(commit: GitCommitSummary, change: GitCommitChange, file: GitCommitFile): string {
	return [
		`File: ${change.path}`,
		...(change.originalPath ? [`Previous path: ${change.originalPath}`] : []),
		`Status: ${change.status}`,
		`Before:\n${formatContent(file.original)}`,
		`After:\n${formatContent(file.modified)}`,
		`Commit: ${commit.objectId}`,
	].join('\n');
}

function formatContent(content: GitCommitFileContent): string {
	switch (content.kind) {
		case 'missing': return '[file does not exist on this side]';
		case 'binary': return '[binary content omitted]';
		case 'text': return truncate(content.text, MaxFileCharacters, 'file content');
	}
}

function truncate(value: string, maximum: number, label: string): string {
	if (value.length <= maximum) return value;
	return `${value.slice(0, maximum)}\n[${label} truncated after ${maximum} characters]`;
}

async function revealChat(accessor: ServicesAccessor): Promise<ChatViewPane | undefined> {
	const view = accessor.get(IViewsService).openView(CHAT_VIEW_ID);
	return view instanceof ChatViewPane ? view : undefined;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.graph.addHistoryItemToChat',
			title: 'Add to Chat',
			menu: { id: MenuId.SCMHistoryItemContext, group: 'z_chat', order: 1 },
		});
	}

	override async run(accessor: ServicesAccessor, commit: GitCommitSummary): Promise<void> {
		if (!isCommit(commit)) return;
		const view = await revealChat(accessor);
		view?.addContext(createCommitChatAttachment(accessor.get(GitService), commit));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.graph.summarizeHistoryItem',
			title: 'Explain Changes',
			menu: { id: MenuId.SCMHistoryItemContext, group: 'z_chat', order: 2 },
		});
	}

	override async run(accessor: ServicesAccessor, commit: GitCommitSummary): Promise<void> {
		if (!isCommit(commit)) return;
		const view = await revealChat(accessor);
		if (!view) return;
		view.addContext(createCommitChatAttachment(accessor.get(GitService), commit));
		await view.acceptInput('Explain the changes in the attached commit.');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.graph.addHistoryItemChangeToChat',
			title: 'Add to Chat',
			menu: { id: MenuId.SCMHistoryItemChangeContext, group: 'z_chat', order: 1 },
		});
	}

	override async run(accessor: ServicesAccessor, commit: GitCommitSummary, change: GitCommitChange): Promise<void> {
		if (!isCommit(commit) || !isCommitChange(change)) return;
		const view = await revealChat(accessor);
		view?.addContext(createCommitChangeChatAttachment(accessor.get(GitService), commit, change));
	}
});

function isCommit(value: unknown): value is GitCommitSummary {
	return typeof value === 'object' && value !== null &&
		typeof (value as GitCommitSummary).repositoryId === 'string' &&
		typeof (value as GitCommitSummary).objectId === 'string' &&
		typeof (value as GitCommitSummary).subject === 'string';
}

function isCommitChange(value: unknown): value is GitCommitChange {
	return typeof value === 'object' && value !== null && typeof (value as GitCommitChange).path === 'string';
}
