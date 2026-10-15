import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import type { ChatContextPicker, IChatContextPickService } from '../../../../../workbench/services/chat/common/chatContextService.js';
import type { ISCMHistoryProvider, ISCMHistoryItem, ISCMHistoryItemChange } from '../../common/history.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';

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

const commit: ISCMHistoryItem = {
	id: '1234567890abcdef', parentIds: ['abcdef1234567890'],
	subject: 'Explain SCM context', message: 'Explain SCM context', displayId: '1234567',
};
const change: ISCMHistoryItemChange = { path: 'src/context.ts', status: 'modified', uri: URI.file('/workspace/src/context.ts') };

test('SCM history picker filters commits and resolves provider context lazily', async () => {
	let picker: ChatContextPicker | undefined;
	let graphRequests = 0, contextRequests = 0;
	const provider = historyFixture({
		provideHistoryItems: async () => { graphRequests++; return [commit, { ...commit, id: 'fedcba9876543210', subject: 'Unrelated commit' }]; },
		resolveHistoryItemChatContext: async id => { assert.equal(id, commit.id); contextRequests++; return 'Provider-owned commit context'; },
	});
	using scmService = new SCMService();
	using repository = scmService.registerSCMProvider(testProvider('repo-1', 'git', 'workspace', provider));
	using otherRepository = scmService.registerSCMProvider(testProvider('other', 'other', 'No history'));
	const pickService = { registerPicker: (value: ChatContextPicker) => { picker = value; return toDisposable(() => { picker = undefined; }); } } as unknown as IChatContextPickService;
	using contribution = new ScmHistoryChatContextContribution(pickService, scmService);
	assert.equal(await picker?.isEnabled(), true);
	const picks = await picker?.providePicks('explain');
	assert.equal(graphRequests, 1);
	assert.deepEqual(picks?.map(pick => [pick.label, pick.description]), [['Explain SCM context', '1234567']]);
	assert.equal(contextRequests, 0);
	assert.equal((await picks?.[0]?.attachment.resolve())?.content, 'Provider-owned commit context');
	assert.equal(contextRequests, 1);
	contribution.dispose();
	assert.equal(picker, undefined);
});

test('SCM history attachments preserve the captured commit and file when delegating context', async () => {
	const requests: unknown[] = [];
	const provider = historyFixture({
		resolveHistoryItemChatContext: async id => { requests.push(id); return 'Commit context'; },
		resolveHistoryItemChangeRangeChatContext: async (id, parent, path) => { requests.push([id, parent, path]); return 'File context'; },
	});
	using scmService = new SCMService();
	using repository = scmService.registerSCMProvider(testProvider('repo-1', 'git', 'workspace', provider));
	const historyItemViewModel = { historyItem: commit, inputSwimlanes: [], outputSwimlanes: [], kind: 'node' as const };
	const first = createHistoryItemChatAttachment({ repository, historyItemViewModel, type: 'historyItemViewModel' });
	const second = createHistoryItemChangeChatAttachment({ repository, historyItemViewModel, historyItemChange: change, graphColumns: [], type: 'historyItemChangeViewModel' });
	assert.deepEqual(requests, []);
	assert.equal((await first.resolve()).content, 'Commit context');
	assert.equal((await second.resolve()).content, 'File context');
	assert.deepEqual(requests, [commit.id, [commit.id, commit.parentIds[0], change.path]]);
});

function historyFixture(overrides: Partial<ISCMHistoryProvider>): ISCMHistoryProvider {
	return {
		onDidChange: Event.None, historyItemRef: observableValue('test.head', undefined), refresh() { }, provideHistoryItems: async () => [],
		resolveHistoryItemDetails: async () => { throw new Error('Unexpected details'); }, provideHistoryItemChanges: async () => [],
		resolveHistoryItemChangeContents: async () => { throw new Error('Unexpected contents'); }, resolveHistoryItemChatContext: async () => undefined,
		resolveHistoryItemChangeRangeChatContext: async () => undefined, ...overrides
	};
}
function testProvider(id: string, providerId: string, label: string, historyProvider?: ISCMHistoryProvider): ISCMProvider {
	return {
		id, providerId, label, historyProvider, groups: [], onDidChangeResources: Event.None,
		input: { value: '', placeholder: '', enabled: false, canAccept: false, buttonLabel: '', buttonTooltip: '', accept: async () => undefined },
		activeRepositoryName: undefined, statusBarCommands: [], statusMessage: '', isBusy: false, refresh: async () => { }, activate: async () => { }
	};
}
