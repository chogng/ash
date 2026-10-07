import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import type { IWorkingCopyHistoryService, IWorkingCopyHistoryEntry } from '../../../../services/workingCopy/common/workingCopyHistory.js';
import { TimelineService } from '../../../timeline/common/timelineService.js';
import { LocalHistoryTimeline } from '../../browser/localHistoryTimeline.js';
import { Event } from '../../../../../base/common/event.js';
import type { IViewsService } from '../../../../services/views/common/viewsService.js';
import '../../../localHistory/browser/localHistory.contribution.js';

const views: IViewsService = {
	onDidChangeViewContainerVisibility: Event.None, onDidChangeViewVisibility: Event.None, onDidChangeFocusedView: Event.None,
	isViewContainerVisible: () => false, isViewContainerActive: () => false, openViewContainer: async () => null, closeViewContainer: () => { }, getVisibleViewContainer: () => null, getActiveViewPaneContainerWithId: () => null, getFocusedView: () => null, getFocusedViewName: () => '',
	isViewVisible: () => false, openView: async () => null, closeView: () => { }, getActiveViewWithId: () => null, getViewWithId: () => null, focusView: async () => false,
};

test('LocalHistoryTimeline pages the existing snapshots, refreshes on save, and releases registration when disabled', async () => {
	using context = new ContextKeyService();
	using timeline = new TimelineService(context, views, new NullLoggerService());
	using configuration = new InMemoryConfigurationService();
	using changed = new Emitter<{ entry: IWorkingCopyHistoryEntry; }>();
	const uri = URI.file('/main.ts');
	const entries: IWorkingCopyHistoryEntry[] = [3, 2, 1].map(timestamp => ({ id: String(timestamp), timestamp, workingCopy: { resource: uri, name: 'main.ts' }, location: URI.file(`/history/${timestamp}`) }));
	const history: IWorkingCopyHistoryService = { onDidAddEntry: changed.event, getEntries: async () => entries, addEntry: async () => { throw new Error('The timeline must not create history entries'); } };
	using provider = new LocalHistoryTimeline(timeline, history, configuration);
	assert.equal(context.getValue('timelineHasProvider'), true);
	const first = await provider.provideTimeline(uri, { limit: 2 }, CancellationToken.None);
	const second = await provider.provideTimeline(uri, { limit: 2, cursor: first.paging?.cursor }, CancellationToken.None);
	assert.deepEqual({ first: first.items.map(item => item.id), cursor: first.paging?.cursor, second: second.items.map(item => item.id), done: second.paging?.cursor }, { first: ['3', '2'], cursor: '2', second: ['1'], done: undefined });
	assert.deepEqual(first.items[0].command?.arguments, [uri, '3']);
	assert.equal((await provider.provideTimeline(uri, { cursor: 'expired', limit: 2 }, CancellationToken.None)).items.length, 0);
	const events: string[] = [];
	using listener = timeline.onDidChangeTimeline(event => events.push(event.uri!.toString()));
	changed.fire({ entry: entries[0] });
	assert.deepEqual(events, [uri.toString()]);
	await configuration.updateValue('workbench.localHistory.enabled', false);
	assert.equal(context.getValue('timelineHasProvider'), false);
	await configuration.updateValue('workbench.localHistory.enabled', true);
	assert.equal(context.getValue('timelineHasProvider'), true);
	await assert.rejects(provider.provideTimeline(uri, {}, CancellationToken.Cancelled), /cancelled/);
});
