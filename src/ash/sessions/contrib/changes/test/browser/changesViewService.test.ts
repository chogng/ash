import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import type { ISessionsService, SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';
import { ChangesViewService } from '../../browser/changesViewService.js';
import { ChangesViewMode } from '../../common/changes.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { autorun } from '../../../../../base/common/observable.js';

suite('Changes window view state', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('persists complete workspace state immediately and ignores writes from a disposed owner', async () => {
		const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://changes.test' });
		try {
			using storage = new BrowserStorageService({
				ownerWindow: dom.window as unknown as Window,
				workspaceId: 'changes',
				flushInterval: 0,
			});
			using context = new ContextKeyService();
			const sessions = {
				onDidChange: Event.None,
				activeSelection: { kind: 'session', active: { session: { sessionId: 'session' }, threadId: 'thread' } },
			} as unknown as ISessionsService;
			using first = new ChangesViewService(storage, sessions, context);
			const resource = URI.parse('ash-session-changes:/session?thread=thread');
			const peer = resource.with({ query: 'thread=peer' });
			const file = URI.parse('ash-turn-diff:/capture/main.ts?session=session&thread=thread&revision=1');
			const snapshot = {
				focus: ['capture:main.ts'],
				selection: ['capture:main.ts'],
				expanded: { folder: 0 as const },
				scrollTop: 64,
			};
			first.setViewMode(ChangesViewMode.Tree);
			first.setChangesetId('capture', resource);
			first.setChangesetId('peer-capture', peer);
			first.setDetailsViewState(resource.with({ fragment: 'capture' }), ChangesViewMode.Tree, snapshot);
			first.setSectionCollapsed(resource, 'checks', true);
			first.setChangesetFilesReviewState([file], true);
			assert.ok(storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).includes('changesView.sessionViewState'));
			first.dispose();
			const stored = storage.get('changesView.sessionViewState', StorageScope.WORKSPACE);
			first.setChangesetId('stale', resource);
			first.setChangesetFilesReviewState([file], false);
			assert.equal(storage.get('changesView.sessionViewState', StorageScope.WORKSPACE), stored);
			using restored = new ChangesViewService(storage, sessions, context);
			assert.equal(restored.getChangesetId(resource), 'capture');
			assert.equal(restored.getChangesetId(peer), 'peer-capture');
			assert.deepEqual(restored.getDetailsViewState(resource.with({ fragment: 'capture' }), ChangesViewMode.Tree), snapshot);
			assert.deepEqual([...restored.reviewedFilesObs.get()], [file.toString()]);
			assert.equal(restored.viewModeObs.get(), ChangesViewMode.Tree);
			assert.deepEqual(restored.activeSessionSectionCollapseStateObs.get(), { checks: true });
			await storage.switchWorkspace('other');
			assert.equal(restored.getChangesetId(resource), undefined);
			assert.deepEqual([...restored.reviewedFilesObs.get()], []);
			assert.equal(restored.getDetailsViewState(resource.with({ fragment: 'capture' }), ChangesViewMode.Tree), undefined);
		} finally {
			dom.window.close();
		}
	});

	test('rejects corrupt, oversized or mismatched persisted state without a partial restore', () => {
		const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://changes.test' });
		try {
			using storage = new BrowserStorageService({
				ownerWindow: dom.window as unknown as Window,
				workspaceId: 'changes',
				flushInterval: 0,
			});
			using context = new ContextKeyService();
			const sessions = { onDidChange: Event.None } as unknown as ISessionsService;
			const resource = URI.parse('ash-session-changes:/session?thread=thread');
			const valid = {
				version: 1,
				changesets: [[resource.toString(), 'capture']],
				details: [],
				sections: [],
				reviewed: [],
			};
			for (const value of [
				'not JSON',
				{ ...valid, version: 2 },
				{ ...valid, reviewed: ['file:///main.ts'] },
				{ ...valid, changesets: [...valid.changesets, ...valid.changesets] },
				{
					...valid,
					changesets: Array.from({ length: 65 }, (_, index) => [`ash-session-changes:/session-${index}?thread=thread`, 'capture']),
				},
				{
					...valid,
					details: [[`${resource}\nlist`, { focus: [], selection: [], expanded: {}, scrollTop: -1 }]],
				},
				{ ...valid, reviewed: ['ash-turn-diff:/capture/main.ts?session=session&thread=thread&revision=wrong'] },
			]) {
				storage.store('changesView.sessionViewState', typeof value === 'string' ? value : JSON.stringify(value), StorageScope.WORKSPACE, StorageTarget.MACHINE);
				using restored = new ChangesViewService(storage, sessions, context);
				assert.equal(restored.getChangesetId(resource), undefined);
				assert.deepEqual([...restored.reviewedFilesObs.get()], []);
			}
		} finally {
			dom.window.close();
		}
	});

	test('observes external choices, preserves live state on corruption and clears state on removal', () => {
		const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://changes.test' });
		try {
			using storage = new BrowserStorageService({
				ownerWindow: dom.window as unknown as Window,
				workspaceId: 'changes',
				flushInterval: 0,
			});
			using context = new ContextKeyService();
			using service = new ChangesViewService(storage, { onDidChange: Event.None } as unknown as ISessionsService, context);
			const resource = URI.parse('ash-session-changes:/session?thread=thread');
			const selections: (string | undefined)[] = [];
			using listener = autorun(reader => {
				selections.push(service.getChangesetId(resource, reader));
			});
			const receive = (value: string | null): void => {
				dom.window.dispatchEvent(
					new dom.window.StorageEvent('storage', {
						key: 'ash.storage.workspace.changes',
						newValue:
							value === null
								? null
								: JSON.stringify({
										version: 1,
										entries: { 'changesView.sessionViewState': { value, target: 'machine' } },
									}),
					}),
				);
			};
			receive(
				JSON.stringify({
					version: 1,
					changesets: [[resource.toString(), 'capture']],
					details: [],
					sections: [],
					reviewed: [],
				}),
			);
			receive('invalid');
			assert.equal(service.getChangesetId(resource), 'capture');
			receive(null);
			assert.deepEqual(selections, [undefined, 'capture', undefined]);
		} finally {
			dom.window.close();
		}
	});

	test('retains choices by Session and Thread across resource aliases and clears only the requested scope', () => {
		const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://changes.test' });
		try {
			using storage = new BrowserStorageService({
				ownerWindow: dom.window as unknown as Window,
				workspaceId: 'changes',
				flushInterval: 0,
			});
			using context = new ContextKeyService();
			let selection: SessionsViewSelection | undefined = {
				kind: 'session',
				active: { session: { sessionId: 'session' }, threadId: 'thread' },
			} as SessionsViewSelection;
			const sessions = {
				onDidChange: Event.None,
				get activeSelection() {
					return selection;
				},
			} as unknown as ISessionsService;
			using service = new ChangesViewService(storage, sessions, context);
			const resource = URI.parse('ash-session-changes:/session?thread=thread');
			const peer = resource.with({ query: 'thread=peer' });
			const other = resource.with({ path: '/other' });
			service.setChangesetId('second');
			service.setChangesetId('peer-capture', peer);
			service.setChangesetId('other-capture', other);
			assert.equal(service.getChangesetId(resource.with({ scheme: 'ash-session', fragment: 'capture' })), 'second');
			assert.equal(service.getChangesetId(peer), 'peer-capture');
			assert.equal(service.getChangesetId(other), 'other-capture');
			service.setChangesetId(undefined, peer);
			assert.equal(service.getChangesetId(peer), undefined);
			assert.equal(service.getChangesetId(resource), 'second');
			selection = undefined;
			service.setChangesetId(undefined);
			assert.equal(service.getChangesetId(resource), 'second');
		} finally {
			dom.window.close();
		}
	});

	test('exposes Viewed on both comparison sides only for the exact revision and releases the window context', () => {
		const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://changes.test' });
		try {
			using storage = new BrowserStorageService({
				ownerWindow: dom.window as unknown as Window,
				workspaceId: 'changes',
				flushInterval: 0,
			});
			using context = new ContextKeyService();
			using service = new ChangesViewService(storage, { onDidChange: Event.None } as unknown as ISessionsService, context);
			const resource = URI.parse('ash-turn-diff:/capture/main.ts?session=session&thread=thread&revision=1');
			service.setChangesetFilesReviewState([resource], true);
			assert.deepEqual(context.getContext().getValue('sessions.changesReviewedFiles'), [resource.toString(), `${resource.toString()}&side=before`, `${resource.toString()}&side=after`]);
			assert.equal(service.reviewedFilesObs.get().has(resource.with({ query: 'session=session&thread=thread&revision=2' }).toString()), false);
			service.dispose();
			assert.deepEqual(context.getContext().getValue('sessions.changesReviewedFiles'), []);
		} finally {
			dom.window.close();
		}
	});
});
