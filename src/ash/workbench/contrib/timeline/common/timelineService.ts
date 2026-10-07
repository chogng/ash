import type { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { URI } from '../../../../base/common/uri.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { type ITimelineService, TimelinePaneId, type Timeline, type TimelineChangeEvent, type TimelineOptions, type TimelineProvider, type TimelineProvidersChangeEvent, type TimelineRequest, type TimelineSource } from './timeline.js';

export const TimelineHasProviderContext = new RawContextKey<boolean>('timelineHasProvider', false);

interface ProviderRegistration {
	readonly provider: TimelineProvider;
	readonly resources: DisposableStore;
	readonly requests: Set<CancellationTokenSource>;
}

/** Window-scoped provider registry. Late results cannot cross a provider replacement or cancellation. */
export class TimelineService extends Disposable implements ITimelineService {
	public readonly _serviceBrand = undefined;
	private readonly providers = new Map<string, ProviderRegistration>();
	private readonly providersChanged = this._register(new Emitter<TimelineProvidersChangeEvent>());
	private readonly timelineChanged = this._register(new Emitter<TimelineChangeEvent>());
	private readonly uriChanged = this._register(new Emitter<URI>());
	public readonly onDidChangeProviders = this.providersChanged.event;
	public readonly onDidChangeTimeline = this.timelineChanged.event;
	public readonly onDidChangeUri = this.uriChanged.event;
	private readonly hasProvider;

	constructor(
		@IContextKeyService context: IContextKeyService,
		@IViewsService private readonly views: IViewsService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this.hasProvider = TimelineHasProviderContext.bindTo(context);
		this._register(toDisposable(() => {
			for (const id of [...this.providers.keys()]) this.unregisterTimelineProvider(id);
			this.hasProvider.reset();
		}));
	}

	public getSources(): TimelineSource[] {
		return [...this.providers.values()].map(({ provider }) => ({ id: provider.id, label: provider.label }));
	}

	public registerTimelineProvider(provider: TimelineProvider): IDisposable {
		this.assertNotDisposed();
		if (!provider.id || this.providers.has(provider.id)) throw new Error(`Timeline provider is already registered or has an empty ID: ${provider.id}`);
		const registration: ProviderRegistration = { provider, resources: new DisposableStore(), requests: new Set() };
		this.providers.set(provider.id, registration);
		if (provider.onDidChange) registration.resources.add(provider.onDidChange(event => {
			this.timelineChanged.fire({ ...event, id: provider.id });
		}));
		this.hasProvider.set(true);
		this.providersChanged.fire({ added: [provider.id] });
		return toDisposable(() => {
			if (this.providers.get(provider.id) === registration) this.unregisterTimelineProvider(provider.id);
		});
	}

	public unregisterTimelineProvider(id: string): void {
		const registration = this.providers.get(id);
		if (!registration) return;
		this.providers.delete(id);
		registration.resources.dispose();
		for (const request of registration.requests) request.cancel();
		registration.requests.clear();
		this.hasProvider.set(this.providers.size > 0);
		this.providersChanged.fire({ removed: [id] });
	}

	public getTimeline(id: string, uri: URI, options: TimelineOptions, tokenSource: CancellationTokenSource): TimelineRequest | undefined {
		this.assertNotDisposed();
		const registration = this.providers.get(id);
		if (!registration || tokenSource.token.isCancellationRequested) return undefined;
		const { provider } = registration;
		const schemes = typeof provider.scheme === 'string' ? [provider.scheme] : provider.scheme;
		if (!schemes.includes('*') && !schemes.includes(uri.scheme)) return undefined;
		if (typeof options.limit === 'number' && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new RangeError('Timeline page size must be a positive integer');
		registration.requests.add(tokenSource);
		const result = Promise.resolve().then(() => provider.provideTimeline(uri, options, tokenSource.token)).then(timeline => {
			if (tokenSource.token.isCancellationRequested || this.providers.get(id) !== registration || !timeline) return undefined;
			const handles = new Set<string>();
			for (const item of timeline.items) {
				if (typeof item.handle !== 'string' || handles.has(item.handle) || typeof item.label !== 'string' || !Number.isFinite(item.timestamp)) throw new TypeError(`Invalid timeline item from ${id}`);
				handles.add(item.handle);
			}
			return { ...timeline, source: id, items: timeline.items.map(item => ({ ...item, source: id })) } satisfies Timeline;
		}).finally(() => registration.requests.delete(tokenSource));
		return { result, source: id, uri, options, tokenSource };
	}

	public setUri(uri: URI): void {
		this.uriChanged.fire(uri);
		void this.views.openView(TimelinePaneId, true).catch(error => this.log.error('timeline', 'Could not open Timeline', error));
	}
}
