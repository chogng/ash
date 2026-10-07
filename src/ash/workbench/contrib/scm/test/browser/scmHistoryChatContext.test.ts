import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import type { ChatContextPicker, IChatContextPickService } from '../../../../../workbench/services/chat/common/chatContextService.js';
import type { GitCommitChange, GitCommitSummary, IGitService } from '../../../../../workbench/contrib/git/common/gitService.js';
import { GitHistoryProvider } from '../../../git/browser/gitHistoryProvider.js';
import { SCMService } from '../../common/scmService.js';
import type { ISCMProvider } from '../../common/scm.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}
const {
	createHistoryItemChatAttachment,
	createHistoryItemChangeChatAttachment,
	ScmHistoryChatContextContribution,
} = await import('../../../../../workbench/contrib/scm/browser/scmHistoryChatContext.js');
suiteTeardown(() => {
	browserEnvironment.window.close();
	for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement']) Reflect.deleteProperty(globalThis, name);
});

const commit: GitCommitSummary = {
	repositoryId: 'repo-1',
	objectId: '1234567890abcdef',
	parentObjectIds: ['abcdef1234567890'],
	timestampSeconds: 1_753_000_000,
	subject: 'Explain SCM context',
};

const change: GitCommitChange = {
	path: 'src/context.ts',
	originalPath: undefined,
	status: 'modified',
};

test('SCM history picker filters commits and resolves bounded context lazily', async () => {
	let picker: ChatContextPicker | undefined;
	let graphRequests = 0;
	let changeRequests = 0;
	let fileRequests = 0;
	const gitService = {
		onDidBecomeReady: Event.None,
		onDidChangeRepositoryStatus: Event.None,
		status: async () => ({ workspacePath: '/workspace', head: { type: 'branch', name: 'main', objectId: commit.objectId, upstream: undefined } }),
		branches: async () => [],
		graph: async () => {
			graphRequests += 1;
			return {
				commits: [commit, { ...commit, objectId: 'fedcba9876543210', subject: 'Unrelated commit' }],
				references: [],
				remotes: [],
				hasMore: false,
				nextCursor: undefined,
			};
		},
		commitChanges: async () => {
			changeRequests += 1;
			return { parentObjectId: commit.parentObjectIds[0], changes: [change] };
		},
		commitFile: async () => {
			fileRequests += 1;
			return {
				original: { kind: 'text' as const, text: 'before\n' },
				modified: { kind: 'text' as const, text: 'after\n' },
			};
		},
	} as unknown as IGitService;
	using scmService = new SCMService();
	using provider = new GitHistoryProvider(gitService, 'repo-1');
	using repository = scmService.registerSCMProvider(testProvider('repo-1', 'git', 'workspace', provider));
	using otherRepository = scmService.registerSCMProvider(testProvider('other', 'other', 'No history'));
	const pickService = {
		registerPicker: (value: ChatContextPicker) => {
			picker = value;
			return toDisposable(() => { picker = undefined; });
		},
	} as unknown as IChatContextPickService;

	using contribution = new ScmHistoryChatContextContribution(pickService, scmService);
	assert.equal(await picker?.isEnabled(), true);
	const picks = await picker?.providePicks('explain');
	assert.equal(graphRequests, 1);
	assert.deepEqual(picks?.map(pick => [pick.label, pick.description]), [['Explain SCM context', '1234567']]);
	assert.equal(changeRequests, 0);
	assert.equal(fileRequests, 0);

	const resolved = await picks?.[0]?.attachment.resolve();
	assert.equal(changeRequests, 1);
	assert.equal(fileRequests, 1);
	assert.match(resolved?.content ?? '', /Commit: 1234567890abcdef/);
	assert.match(resolved?.content ?? '', /Before:\nbefore/);
	assert.match(resolved?.content ?? '', /After:\nafter/);

	contribution.dispose();
	assert.equal(picker, undefined);
});

test('SCM history attachments cap files and preserve binary or missing sides', async () => {
	const changes = Array.from({ length: 45 }, (_, index): GitCommitChange => ({
		path: index === 0 ? change.path : `src/file-${index}.ts`,
		originalPath: undefined,
		status: 'modified',
	}));
	let fileRequests = 0;
	const gitService = {
		onDidBecomeReady: Event.None,
		onDidChangeRepositoryStatus: Event.None,
		status: async () => ({ repositoryId: 'repo-1', head: { type: 'branch', name: 'main', objectId: commit.objectId, upstream: undefined }, changes: [] }),
		branches: async () => [],
		graph: async () => ({ commits: [commit], references: [], remotes: [], hasMore: false, nextCursor: undefined }),
		commitChanges: async () => ({ parentObjectId: commit.parentObjectIds[0], changes }),
		commitFile: async () => {
			fileRequests += 1;
			return { original: { kind: 'binary' as const }, modified: { kind: 'missing' as const } };
		},
	} as unknown as IGitService;
	using scmService = new SCMService();
	using provider = new GitHistoryProvider(gitService, 'repo-1');
	using repository = scmService.registerSCMProvider(testProvider('repo-1', 'git', 'workspace', provider));
	const historyItem = (await provider.provideHistoryItems({ limit: 100 }))[0];
	const historyItemViewModel = { historyItem, inputSwimlanes: [], outputSwimlanes: [], kind: 'node' as const };

	const resolved = await createHistoryItemChatAttachment({ repository, historyItemViewModel, type: 'historyItemViewModel' }).resolve();
	assert.equal(fileRequests, 40);
	assert.match(resolved.content, /\[binary content omitted\]/);
	assert.match(resolved.content, /\[file does not exist on this side\]/);
	assert.match(resolved.content, /\[5 additional files omitted\]/);

	const historyItemChange = (await provider.provideHistoryItemChanges(historyItem.id, historyItem.parentIds[0]))![0];
	const file = await createHistoryItemChangeChatAttachment({ repository, historyItemViewModel, historyItemChange, graphColumns: [], type: 'historyItemChangeViewModel' }).resolve();
	assert.equal(fileRequests, 41);
	assert.match(file.content, /File: src\/context\.ts/);
});

function testProvider(id: string, providerId: string, label: string, historyProvider?: GitHistoryProvider): ISCMProvider {
	return {
		id, providerId, label, historyProvider,
		groups: [], onDidChangeResources: Event.None,
		input: { value: '', placeholder: '', enabled: false, canAccept: false, buttonLabel: '', buttonTooltip: '', accept: async () => undefined },
		activeRepositoryName: undefined, statusBarCommands: [], statusMessage: '', isBusy: false,
		refresh: async () => { }, activate: async () => { },
	};
}
