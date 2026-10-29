import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { IFileSearchService } from '../../../../../platform/search/common/fileSearch.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IChatAttachmentResolveService, ChatAttachmentResolveService } from '../../../chat/browser/attachments/chatAttachmentResolveService.js';
import { ISCMService } from '../../common/scm.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { isChatContextPickerPickItem, type IChatContextPickerItem, type IChatContextValueItem, type IChatContextPickerPickItem } from '../../../chat/browser/attachments/chatContextPickService.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import { IChatContextPickService } from '../../../chat/browser/attachments/chatContextPickService.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import { test, suite, suiteTeardown } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { JSDOM } from 'jsdom';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';

import { SCMHistoryItemUri, type ISCMHistoryProvider, type ISCMHistoryItem, type ISCMHistoryItemChange } from '../../common/history.js';
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
const { ScmHistoryChatContextContribution } = await import('../../../../../workbench/contrib/scm/browser/scmHistoryChatContext.js');
suiteTeardown(() => {
	browserEnvironment.window.close();
	for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement']) Reflect.deleteProperty(globalThis, name);
});

const commit: ISCMHistoryItem = {
	id: '1234567890abcdef',
	parentIds: ['abcdef1234567890'],
	subject: 'Explain SCM context',
	message: 'Explain SCM context',
	displayId: '1234567',
};
const change: ISCMHistoryItemChange = {
	path: 'src/context.ts',
	status: 'modified',
	uri: URI.file('/workspace/src/context.ts'),
};

for (const locale of ['en', 'zh-CN'])
	test(`SCM history picker filters commits and resolves provider context lazily in ${locale}`, async () => {
		using resetLocale = toDisposable(() => resetNlsResolver());
		setNlsMessages(locale, locale === 'zh-CN' ? JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')) : {});
		using owner = resolverServices();
		let picker: IChatContextPickerItem | undefined;
		let graphRequests = 0,
			contextRequests = 0;
		const listed = { ...commit, comparison: { revision: 'listed:tip', baseRevision: 'listed:base' } };
		const provider = historyFixture({
			provideHistoryItems: async () => {
				graphRequests++;
				return [listed, { ...commit, id: 'fedcba9876543210', subject: 'Unrelated commit' }];
			},
			resolveHistoryItemChatContext: async id => {
				assert.equal(id, 'listed:tip');
				contextRequests++;
				return 'Provider-owned commit context';
			},
		});
		using scmService = new SCMService();
		using repository = scmService.registerSCMProvider(testProvider('repo-1', 'git', 'workspace', provider));
		using otherRepository = scmService.registerSCMProvider(testProvider('other', 'other', 'No history'));
		const pickService = {
			registerChatContextItem: (value: IChatContextPickerItem) => {
				picker = value;
				return toDisposable(() => {
					picker = undefined;
				});
			},
		} as unknown as IChatContextPickService;
		owner.registerInstance(IChatContextPickService, pickService);
		owner.registerInstance(ISCMService, scmService);
		using contribution = owner.createInstance(ScmHistoryChatContextContribution);
		assert.equal(picker!.label, locale === 'zh-CN' ? '源代码管理' : 'Source Control');
		assert.equal(await picker?.isEnabled?.(), true);
		const picks = await readContextPicks(picker!, 'explain');
		assert.equal(graphRequests, 1);
		assert.deepEqual(
			picks?.map(pick => [pick.label, pick.description]),
			[['Explain SCM context', '1234567']],
		);
		assert.equal(contextRequests, 0);
		listed.comparison.revision = 'moved:tip';
		assert.equal((await (await selectedAttachment(picks[0]!)).resolve()).content, 'Provider-owned commit context');
		assert.equal(contextRequests, 1);
		contribution.dispose();
		assert.equal(picker, undefined);
	});

test('SCM history attachments preserve the captured commit and file when delegating context', async () => {
	using owner = resolverServices();
	const resolver = owner.get(IChatAttachmentResolveService);
	const requests: unknown[] = [];
	const provider = historyFixture({
		resolveHistoryItemChatContext: async id => {
			requests.push(id);
			return 'Commit context';
		},
		resolveHistoryItemChangeRangeChatContext: async (id, parent, path) => {
			requests.push([id, parent, path]);
			return 'File context';
		},
	});
	using scmService = new SCMService();
	using repository = scmService.registerSCMProvider(testProvider('repo-1', 'git', 'workspace', provider));
	const historyItemViewModel = {
		historyItem: commit,
		inputSwimlanes: [],
		outputSwimlanes: [],
		kind: 'node' as const,
	};
	const first = resolver.resolveSourceControlHistoryItemAttachContext([{ repository, historyItemViewModel, type: 'historyItemViewModel' }])[0]!;
	const second = resolver.resolveSourceControlHistoryItemAttachContext([
		{
			repository,
			historyItemViewModel,
			historyItemChange: change,
			graphColumns: [],
			type: 'historyItemChangeViewModel',
		},
	])[0]!;
	assert.deepEqual(requests, []);
	assert.equal((await first.resolve()).content, 'Commit context');
	assert.equal((await second.resolve()).content, 'File context');
	assert.deepEqual(requests, [commit.id, [commit.id, commit.parentIds[0], change.path]]);
});

suite('SCM history Chat source identity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('SCM sources and resolvers retain captured comparison and parent identities across URI serialization', async () => {
		using owner = resolverServices();
		const resolver = owner.get(IChatAttachmentResolveService);
		const requests: unknown[] = [];
		const provider = historyFixture({
			resolveHistoryItemChatContext: async revision => {
				requests.push(revision);
				return 'Commit';
			},
			resolveHistoryItemChangeRangeChatContext: async (...args) => {
				requests.push(args);
				return 'Change';
			},
		});
		using scm = new SCMService();
		using repository = scm.registerSCMProvider(testProvider('repo:分支/?#', 'git', 'workspace', provider));
		const item = { ...commit, comparison: { revision: 'captured:tip', baseRevision: 'captured:base' } };
		const file = { ...change, path: 'src/中文 #?:file.ts', parentId: 'merge:parent' };
		const historyItemViewModel = {
			historyItem: item,
			inputSwimlanes: [],
			outputSwimlanes: [],
			kind: 'node' as const,
		};
		const first = resolver.resolveSourceControlHistoryItemAttachContext([{ repository, historyItemViewModel, type: 'historyItemViewModel' }])[0]!;
		const second = resolver.resolveSourceControlHistoryItemAttachContext([
			{
				repository,
				historyItemViewModel,
				historyItemChange: file,
				graphColumns: [],
				type: 'historyItemChangeViewModel',
			},
		])[0]!;
		Object.assign(item.comparison, { revision: 'moved:tip', baseRevision: 'moved:base' });
		Object.assign(file, { path: 'other.ts', parentId: 'other:parent' });
		assert.deepEqual(SCMHistoryItemUri.fromUri(URI.parse(first.resource!.toString())), {
			repositoryId: repository.id,
			revision: 'captured:tip',
			baseRevision: 'captured:base',
			path: undefined,
		});
		assert.deepEqual(SCMHistoryItemUri.fromUri(URI.parse(second.resource!.toString())), {
			repositoryId: repository.id,
			revision: 'captured:tip',
			baseRevision: 'merge:parent',
			path: 'src/中文 #?:file.ts',
		});
		await first.resolve();
		await second.resolve();
		assert.deepEqual(requests, ['captured:tip', ['captured:tip', 'merge:parent', 'src/中文 #?:file.ts']]);
	});

	test('SCM source URI rejects malformed or mismatched clipboard identities', () => {
		const valid = SCMHistoryItemUri.toUri({ repositoryId: 'repo', revision: 'commit' });
		for (const resource of [
			undefined,
			URI.file('/repo'),
			valid.with({ query: '{' }),
			valid.with({ query: 'null' }),
			valid.with({ query: '{"repositoryId":4,"revision":"commit"}' }),
			valid.with({ query: '{"repositoryId":"repo","revision":""}' }),
			valid.with({ path: '/change' }),
			valid.with({ fragment: 'injected' }),
			valid.with({ query: '{"repositoryId":"repo","revision":"commit","baseRevision":2}' }),
		]) {
			assert.equal(SCMHistoryItemUri.fromUri(resource), undefined);
		}
	});
});

function historyFixture(overrides: Partial<ISCMHistoryProvider>): ISCMHistoryProvider {
	return {
		onDidChange: Event.None,
		historyItemRef: observableValue('test.head', undefined),
		refresh() {},
		provideHistoryItems: async () => [],
		provideHistoryItemChanges: async () => [],
		resolveHistoryItemChangeContents: async () => {
			throw new Error('Unexpected contents');
		},
		resolveHistoryItemChatContext: async () => undefined,
		resolveHistoryItemChangeRangeChatContext: async () => undefined,
		...overrides,
	};
}
function testProvider(id: string, providerId: string, label: string, historyProvider?: ISCMHistoryProvider): ISCMProvider {
	return {
		id,
		providerId,
		label,
		historyProvider,
		groups: [],
		onDidChangeResources: Event.None,
		input: {
			value: '',
			placeholder: '',
			enabled: false,
			canAccept: false,
			buttonLabel: '',
			buttonTooltip: '',
			accept: async () => undefined,
		},
		activeRepositoryName: undefined,
		statusBarCommands: [],
		statusMessage: '',
		isBusy: false,
		refresh: async () => {},
		activate: async () => {},
	};
}

async function readContextPicks(source: IChatContextPickerItem | IChatContextValueItem, query: string): Promise<IChatContextPickerPickItem[]> {
	if (source.type !== 'pickerPick') throw new Error('Expected the registered picker contract');
	const picker = source.asPicker();
	const cancellation = new CancellationTokenSource();
	try {
		if (typeof picker.picks !== 'function') return (await picker.picks).filter(isChatContextPickerPickItem);
		const state = picker.picks(observableValue('test.query', query), cancellation.token);
		if (!state.get().busy) {
			if (state.get().error) throw state.get().error;
			return state.get().picks.filter(isChatContextPickerPickItem);
		}
		return await new Promise((resolve, reject) => {
			const listener = state.onDidChange(value => {
				if (value.busy) return;
				listener.dispose();
				if (value.error) reject(value.error);
				else resolve(value.picks.filter(isChatContextPickerPickItem));
			});
		});
	} finally {
		cancellation.dispose(true);
		picker.dispose?.();
	}
}

async function selectedAttachment(item: IChatContextPickerPickItem): Promise<ChatContextAttachment> {
	const result = await item.asAttachment();
	if (result === 'noop' || Array.isArray(result)) throw new Error('Expected one captured context');
	return result;
}

function resolverServices(): InstantiationService {
	const owner = new InstantiationService();
	owner.registerInstance(IFileService, { hasProvider: () => false } as unknown as IFileService);
	owner.registerInstance(IWorkingCopyService, { get: () => [] } as unknown as IWorkingCopyService);
	owner.registerInstance(IFileSearchService, {} as IFileSearchService);
	owner.registerInstance(IWorkspaceContextService, {} as IWorkspaceContextService);
	owner.registerSingleton(IChatAttachmentResolveService, () => owner.createInstance(ChatAttachmentResolveService));
	return owner;
}
