import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import type { ChatContextPicker, IChatContextPickService } from '../../../../../workbench/services/chat/common/chatContextService.js';
import type { GitCommitChange, GitCommitSummary, IGitService } from '../../../../../workbench/services/git/common/gitService.js';

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
	createCommitChatAttachment,
	createCommitChangeChatAttachment,
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
		status: async () => ({ workspacePath: '/workspace' }),
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
	const pickService = {
		registerPicker: (value: ChatContextPicker) => {
			picker = value;
			return toDisposable(() => { picker = undefined; });
		},
	} as unknown as IChatContextPickService;

	using contribution = new ScmHistoryChatContextContribution(pickService, gitService);
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
		path: `src/file-${index}.ts`,
		originalPath: undefined,
		status: 'modified',
	}));
	let fileRequests = 0;
	const gitService = {
		commitChanges: async () => ({ parentObjectId: commit.parentObjectIds[0], changes }),
		commitFile: async () => {
			fileRequests += 1;
			return { original: { kind: 'binary' as const }, modified: { kind: 'missing' as const } };
		},
	} as unknown as IGitService;

	const resolved = await createCommitChatAttachment(gitService, commit).resolve();
	assert.equal(fileRequests, 40);
	assert.match(resolved.content, /\[binary content omitted\]/);
	assert.match(resolved.content, /\[file does not exist on this side\]/);
	assert.match(resolved.content, /\[5 additional files omitted\]/);

	const file = await createCommitChangeChatAttachment(gitService, commit, change).resolve();
	assert.equal(fileRequests, 41);
	assert.match(file.content, /File: src\/context\.ts/);
});
