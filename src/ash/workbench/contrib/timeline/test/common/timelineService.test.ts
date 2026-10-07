import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import type { IViewsService } from '../../../../services/views/common/viewsService.js';
import type { Timeline, TimelineProvider, TimelineChangeEvent } from '../../common/timeline.js';
import { TimelineService } from '../../common/timelineService.js';

const views: IViewsService = {
	onDidChangeViewContainerVisibility: Event.None, onDidChangeViewVisibility: Event.None, onDidChangeFocusedView: Event.None,
	isViewContainerVisible: () => false, isViewContainerActive: () => false, openViewContainer: async () => null, closeViewContainer: () => { },
	getVisibleViewContainer: () => null, getActiveViewPaneContainerWithId: () => null, getFocusedView: () => null, getFocusedViewName: () => '',
	isViewVisible: () => false, openView: async () => null, closeView: () => { }, getActiveViewWithId: () => null, getViewWithId: () => null, focusView: async () => false,
};
const uri = URI.file('/test.ts');
const result: Timeline = { source: 'ignored', items: [{ source: 'ignored', handle: 'save', label: 'Saved', timestamp: 100 }] };
const provider: TimelineProvider = { id: 'history', label: 'History', scheme: 'file', provideTimeline: async () => result, dispose: () => { }, [Symbol.dispose]: () => { } };

suite('TimelineService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('tracks provider capability and changes, checks schemes, and canonicalizes item sources', async () => {
		using context = new ContextKeyService();
		using service = new TimelineService(context, views, new NullLoggerService());
		using changes = new Emitter<TimelineChangeEvent>();
		const events: TimelineChangeEvent[] = [];
		using listener = service.onDidChangeTimeline(event => events.push(event));
		const registration = service.registerTimelineProvider({ ...provider, onDidChange: changes.event });
		assert.equal(context.getValue('timelineHasProvider'), true);
		assert.deepEqual(service.getSources(), [{ id: 'history', label: 'History' }]);
		assert.throws(() => service.registerTimelineProvider(provider), /already registered/);
		changes.fire({ id: 'wrong', uri, reset: true });
		using token = new CancellationTokenSource();
		assert.equal(service.getTimeline('history', URI.parse('untitled:test'), {}, token), undefined);
		assert.throws(() => service.getTimeline('history', uri, { limit: 0 }, token), /positive integer/);
		assert.deepEqual(await service.getTimeline('history', uri, { limit: 1 }, token)?.result, { source: 'history', items: [{ ...result.items[0], source: 'history' }] });
		registration.dispose();
		changes.fire({ id: 'history', uri, reset: true });
		assert.deepEqual(events, [{ id: 'history', uri, reset: true }]);
		assert.equal(context.getValue('timelineHasProvider'), false);
	});

	test('cancels removed requests immediately and rejects late results from a replaced provider', async () => {
		using context = new ContextKeyService();
		using service = new TimelineService(context, views, new NullLoggerService());
		const pending = new DeferredPromise<Timeline>();
		using first = service.registerTimelineProvider({ ...provider, provideTimeline: () => pending.p });
		using token = new CancellationTokenSource();
		const request = service.getTimeline('history', uri, {}, token)!;
		await Promise.resolve();
		first.dispose();
		assert.equal(token.token.isCancellationRequested, true);
		assert.equal(await request.result, undefined);
		using replacement = service.registerTimelineProvider(provider);
		first.dispose();
		pending.complete(result);
		using second = new CancellationTokenSource();
		assert.equal((await service.getTimeline('history', uri, {}, second)?.result)?.items.length, 1);
		assert.equal(context.getValue('timelineHasProvider'), true);
	});

	test('canceled queued requests do not call providers and malformed entries cannot reach a pane', async () => {
		using context = new ContextKeyService();
		using service = new TimelineService(context, views, new NullLoggerService());
		let calls = 0;
		using registration = service.registerTimelineProvider({ ...provider, provideTimeline: async () => { calls++; return { ...result, items: [...result.items, ...result.items] }; } });
		using token = new CancellationTokenSource();
		const canceled = service.getTimeline('history', uri, {}, token)!;
		token.cancel();
		assert.equal(await canceled.result, undefined);
		assert.equal(calls, 0);
		using next = new CancellationTokenSource();
		await assert.rejects(service.getTimeline('history', uri, {}, next)!.result, /Invalid timeline item/);
	});
});
