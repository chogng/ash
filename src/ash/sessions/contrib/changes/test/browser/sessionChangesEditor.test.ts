import { registerTestComponentServices } from '../../../../../workbench/test/common/testEditorServices.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService, AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { IChatService, type ThreadUpdateEnvelope, type ThreadChangesSummary, type TurnChangeSetSummary } from '../../../../../workbench/services/chat/common/chatService.js';

import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { SessionChangesEditor } from '../../browser/sessionChangesEditor.js';
import { URI } from '../../../../../base/common/uri.js';
import '../../browser/changes.contribution.js';
import { ISessionChangesService } from '../../common/sessionChangesService.js';
import { SessionChangesService } from '../../browser/sessionChangesService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';
import { IDecorationsService, type IDecorationsProvider } from '../../../../../workbench/services/decorations/common/decorations.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Event } from '../../../../../base/common/event.js';
import { EditorPanes } from '../../../../../workbench/browser/editor.js';
import { EditorPane, EditorPaneMatch } from '../../../../../workbench/browser/parts/editor/editorPane.js';
import type { MultiDiffEditorInput } from '../../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { createSessionFileChange } from '../../../../services/sessions/common/session.js';
import { SessionChangesEditorInput } from '../../browser/sessionChangesEditorInput.js';
import { resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';

const emptySummary: ThreadChangesSummary = { sequence: 1, revision: 'empty', statistics: { files: 0, additions: 0, deletions: 0 }, repositories: [], warnings: [] };

suite('Changes editor overlapping opens', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const cancelFirst of [false, true]) test(`a ${cancelFirst ? 'cancelled' : 'replaced'} open finishes without clearing a retry of the same input`, async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		using domOwner = toDisposable(() => dom.window.close());
		using services = registerTestComponentServices(new InstantiationService());
		using context = new ContextKeyService();
		services.registerInstance(IContextKeyService, context);
		using configuration = new InMemoryConfigurationService();
		services.registerInstance(IConfigurationService, configuration);
		using changes = new Emitter<{ sessionId: string; threadId: string; }>();
		const pending = new DeferredPromise<ThreadChangesSummary>();
		let requests = 0;
		const counts: (number | undefined)[] = [];
		services.registerInstance(ISessionChangesService, { setChangesCount: (_resource: URI, count: number | undefined) => { counts.push(count); } } as unknown as ISessionChangesService);
		services.registerInstance(ISessionsManagementService, { sessions: [{ sessionId: 'a' }] } as unknown as ISessionsManagementService);
		services.registerInstance(IChatService, {
			onDidUpdateThread: Event.None, onDidUpdateTurnChanges: changes.event, onDidBecomeReady: Event.None,
			readThreadChanges: async () => ++requests === 1 ? pending.p : emptySummary,
		} as unknown as IChatService);
		services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
		using pane = services.createInstance(SessionChangesEditor, {});
		pane.create(dom.window.document.body);
		pane.setVisible(true);
		const input = { resource: URI.parse('ash-session-changes:/a?thread=a-thread') };
		const controller = new AbortController();
		const first = pane.setInput(input, controller.signal);
		const rejected = assert.rejects(first, { name: 'CancellationError' });
		if (cancelFirst) { controller.abort(); }
		await pane.setInput(input, new AbortController().signal);
		await rejected;
		controller.abort();
		await pending.error(new Error('Old ledger failed'));
		changes.fire({ sessionId: 'a', threadId: 'a-thread' });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(requests, 3);
		assert.equal(pane.getAccessibleContent(), 'No changes in this conversation.');
		assert.deepEqual(counts, [undefined, undefined, 0, undefined, 0]);
		pane.dispose();
		await assert.rejects(pane.setInput(input, new AbortController().signal), { name: 'CancellationError' });
		changes.fire({ sessionId: 'a', threadId: 'a-thread' });
		assert.equal(requests, 3);
	});
});

test('a hidden Changes editor ignores a late ledger result and loads fresh content when shown', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using services = new InstantiationService();
	services.registerSingleton(ISessionChangesService, () => services.createInstance(SessionChangesService));
	let decorations: IDecorationsProvider | undefined;
	services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { } } as unknown as IEditorService);
	services.registerInstance(IDecorationsService, { registerDecorationsProvider: (provider: IDecorationsProvider) => { decorations = provider; return toDisposable(() => { }); } } as unknown as IDecorationsService);
	services.registerInstance(IQuickInputService, { input: async () => undefined } as unknown as IQuickInputService);
	services.registerInstance(IEditorGroupsService, { groups: [] } as unknown as IEditorGroupsService);
	using configuration = new InMemoryConfigurationService();
	using context = new ContextKeyService();
	using changes = new Emitter<{ sessionId: string; threadId: string; }>();
	using ready = new Emitter<void>();
	const pending = new DeferredPromise<ThreadChangesSummary>();
	let requests = 0;
	let failed = false;
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextKeyService, context);
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	services.registerInstance(ISessionsManagementService, { sessions: [{ sessionId: 'a' }] } as unknown as ISessionsManagementService);
	services.registerInstance(IChatService, {
		onDidUpdateThread: Event.None, onDidUpdateTurnChanges: changes.event,
		onDidBecomeReady: ready.event,
		readThreadChanges: () => ++requests === 1 ? pending.p : failed ? Promise.reject(new Error('Unavailable')) : Promise.resolve(emptySummary),
	} as unknown as IChatService);
	using pane = registerTestComponentServices(services).createInstance(SessionChangesEditor, {});
	pane.create(dom.window.document.body);
	const resource = URI.parse('ash-session-changes:/a?thread=a-thread');
	const changesService = services.get(ISessionChangesService);
	changesService.setChangesCount(resource, 5);
	await pane.setInput({ resource }, new AbortController().signal);
	pane.setVisible(true);
	assert.equal(await decorations!.provideDecorations(resource, CancellationToken.None), undefined);
	pane.setVisible(false);
	await pending.complete({ ...emptySummary, revision: 'late', statistics: { files: 1, additions: 1, deletions: 0 } });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(requests, 1);
	assert.equal(pane.getAccessibleContent(), 'Loading changes…');
	pane.setVisible(true);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(requests, 2);
	assert.equal(pane.getAccessibleContent(), 'No changes in this conversation.');
	assert.equal((await decorations!.provideDecorations(resource, CancellationToken.None))?.letter, '0');
	services.registerInstance(IEditorPart, { activePane: pane } as unknown as IEditorPart);
	const accessibility = AccessibleViewRegistry.getImplementations().filter(provider => provider.name.startsWith('sessionsChangesEditor.'));
	assert.equal(accessibility.length, 2);
	for (const implementation of accessibility) {
		using provider = implementation.getProvider(services)!;
		if (implementation.type === AccessibleViewType.View) {
			assert.equal(provider.provideContent(), pane.getAccessibleContent());
		} else {
			assert.match(provider.provideContent(), /The file list and comparisons share this editor/u);
			assert.match(provider.provideContent(), /Changes is a separate tool card with a title toolbar for each editor group/u);
			assert.match(provider.provideContent(), /open Diff View to choose Inline, Side by Side, or Automatic/u);
			const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN');
			assert.ok(chinese);
			setNlsResolver((bundle, key, fallback) => chinese.bundles[bundle]?.[key] ?? fallback);
			try {
				assert.match(provider.provideContent(), /“更改”是一张独立工具卡，每个编辑器组都有自己的标题工具栏/u);
				assert.match(provider.provideContent(), /打开“差异视图”.*“行内”“并排”或“自动”/u);
			} finally {
				resetNlsResolver();
			}
		}
		provider.dispose();
		assert.equal(dom.window.document.activeElement, dom.window.document.querySelector('.ash-sessions-changes-editor'));
	}
	failed = true;
	ready.fire();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.match(pane.getAccessibleContent(), /Unavailable/u);
	assert.equal(await decorations!.provideDecorations(resource, CancellationToken.None), undefined);
	pane.clearInput();
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(pane.setInput({ resource: URI.parse('ash-session-changes:/a?thread=a-thread') }, cancelled.signal), { name: 'CancellationError' });
	changes.fire({ sessionId: 'a', threadId: 'a-thread' });
	assert.equal(requests, 3);
	dom.window.close();
});


test('the default Changes editor reviews the backend checkpoint, resolves exact file identities and follows undo', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using domOwner = toDisposable(() => dom.window.close());
	using services = registerTestComponentServices(new InstantiationService());
	using contexts = new ContextKeyService();
	using configuration = new InMemoryConfigurationService();
	using history = new Emitter<ThreadUpdateEnvelope>();
	const file = (path: string) => ({ path, kind: 'modified' as const, binary: false, additions: 1, deletions: 0 });
	let summary: ThreadChangesSummary = {
		sequence: 2, revision: 'checkpoint', statistics: { files: 3, additions: 3, deletions: 0 }, repositories: [
			{ repositoryId: 'repo', files: [file('main.ts'), file('repo/main.ts')] },
			{ repositoryId: 'other', files: [file('main.ts')] },
		], warnings: []
	};
	let comparison: MultiDiffEditorInput | undefined;
	const counts: (number | undefined)[] = [];
	class SnapshotPane extends EditorPane {
		readonly id = 'test.checkpoint';
		constructor() { super('test.checkpoint', services.get(IThemeService), services.get(IStorageService)); }
		async setInput(input: MultiDiffEditorInput): Promise<void> { comparison = input; }
		clearInput(): void { }
		layout(): void { }
		focus(): void { }
	}
	using registration = EditorPanes.registerEditorPane({
		id: 'test.checkpoint', name: 'Checkpoint',
		canOpen: input => input.resource.scheme === 'ash-multi-diff' ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => new SnapshotPane(),
	});
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextKeyService, contexts);
	services.registerInstance(ISessionsManagementService, { sessions: [{ sessionId: 'session' }] } as unknown as ISessionsManagementService);
	services.registerInstance(ISessionChangesService, { setChangesCount: (_resource: URI, count: number | undefined) => counts.push(count) } as unknown as ISessionChangesService);
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	services.registerInstance(IChatService, {
		onDidUpdateThread: history.event, onDidUpdateTurnChanges: Event.None, onDidBecomeReady: Event.None,
		readThreadChanges: async () => summary,
		readThreadChangeFile: async (_session: string, _thread: string, revision: string, repository: string, path: string) => {
			assert.equal(revision, summary.revision);
			return { path, before: 'baseline', after: `${repository}/${path}`, binary: false, truncated: false };
		},
		listTurnChanges: async () => { throw new Error('A checkpoint must not be reconstructed from Turn captures'); },
	} as unknown as IChatService);
	using pane = services.createInstance(SessionChangesEditor, {});
	pane.create(dom.window.document.body);
	pane.setVisible(true);
	await pane.setInput({ resource: URI.parse('ash-session-changes:/session?thread=thread') }, new AbortController().signal);
	assert.equal(counts.at(-1), 3);
	assert.deepEqual(comparison!.items.map(item => item.modified.initialText), ['repo/main.ts', 'repo/repo/main.ts', 'other/main.ts']);
	assert.equal(new Set(comparison!.items.map(item => item.modified.resource.toString())).size, 3);
	const nested = comparison!.items[1]!;
	const change = await pane.getFileChange(nested.original.resource, { review: true });
	assert.equal(change?.file.path, 'repo/main.ts');
	assert.ok(change && !('summary' in change));
	assert.equal(change.repositoryId, 'repo');
	assert.equal(comparison!.items[1]!.contextKeys?.['sessions.changesCanReview'], true);
	summary = { ...emptySummary, sequence: 3, revision: 'undone' };
	assert.equal(await pane.getFileChange(nested.modified.resource, { review: true }), undefined);
	history.fire({ sessionId: 'session', threadId: 'thread', durableSequence: 3, update: { type: 'committed', event: { type: 'threadHistoryMoved' } } });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(counts.at(-1), 0);
	assert.equal(pane.getAccessibleContent(), 'No changes in this conversation.');
});

test('a Turn Changes editor includes every repository capture for that turn and excludes other turns', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using domOwner = toDisposable(() => dom.window.close());
	using services = registerTestComponentServices(new InstantiationService());
	using contexts = new ContextKeyService();
	using configuration = new InMemoryConfigurationService();
	const capture = (changeSetId: string, turnId: string, repositoryId: string): TurnChangeSetSummary => ({
		sessionId: 'session', threadId: 'thread', changeSetId, turnId, repositoryId, revision: 1,
		captureState: 'sealed', messageState: 'unconfigured', commitState: 'idle', committedPaths: [],
		statistics: { files: 1, additions: 1, deletions: 0 }, dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [],
	});
	const captures = [capture('first', 'older', 'a'), capture('second', 'selected', 'a'), capture('third', 'selected', 'b')];
	const file = { path: 'main.ts', kind: 'modified' as const, binary: false, additions: 1, deletions: 0 };
	const fileReads: string[] = [];
	let comparison: MultiDiffEditorInput | undefined;
	class TurnPane extends EditorPane {
		readonly id = 'test.turn';
		constructor() { super('test.turn', services.get(IThemeService), services.get(IStorageService)); }
		async setInput(input: MultiDiffEditorInput): Promise<void> { comparison = input; }
		clearInput(): void { }
		layout(): void { }
		focus(): void { }
	}
	using registration = EditorPanes.registerEditorPane({
		id: 'test.turn', name: 'Turn',
		canOpen: input => input.resource.scheme === 'ash-multi-diff' ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => new TurnPane(),
	});
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextKeyService, contexts);
	services.registerInstance(ISessionsManagementService, { sessions: [{ sessionId: 'session' }] } as unknown as ISessionsManagementService);
	services.registerInstance(ISessionChangesService, {
		setChangesCount: () => { },
		resolveChangeset: async (_resource: URI, id: string) => ({
			isEnabled: constObservable(true),
			capabilities: { review: id === 'second' },
			changes: constObservable([createSessionFileChange(captures.find(summary => summary.changeSetId === id)!, file)]),
		}),
	} as unknown as ISessionChangesService);
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	services.registerInstance(IChatService, {
		onDidUpdateThread: Event.None, onDidUpdateTurnChanges: Event.None, onDidBecomeReady: Event.None,
		listTurnChanges: async () => captures,
		readTurnChange: async (_session: string, _thread: string, id: string) => ({ summary: captures.find(summary => summary.changeSetId === id)!, files: [file] }),
		readTurnChangeFile: async (_session: string, _thread: string, id: string) => {
			fileReads.push(id);
			return { before: 'baseline', after: id, binary: false, truncated: false };
		},
	} as unknown as IChatService);
	using pane = services.createInstance(SessionChangesEditor, {});
	pane.create(dom.window.document.body);
	pane.setVisible(true);
	await pane.setInput(new SessionChangesEditorInput(URI.parse('ash-session-changes:/session?thread=thread'), { kind: 'turn', turnId: 'selected' }), new AbortController().signal);
	assert.deepEqual(fileReads, ['second', 'third']);
	assert.deepEqual(comparison!.items.map(item => item.modified.initialText), ['second', 'third']);
	assert.deepEqual(comparison!.items.map(item => item.contextKeys?.['sessions.changesCanReview']), [true, false]);
	assert.equal(new Set(comparison!.items.map(item => item.modified.resource.toString())).size, 2);
});
