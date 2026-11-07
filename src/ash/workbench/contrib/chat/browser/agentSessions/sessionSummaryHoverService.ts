import { equals } from '../../../../../base/common/arrays.js';
import { cancelOnDispose, type CancellationToken } from '../../../../../base/common/cancellation.js';
import type { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { SessionSummaryHoverWidget, type ISessionSummaryHoverData } from './sessionSummaryHover.js';

export const ISessionSummaryHoverService = createDecorator<ISessionSummaryHoverService>('sessionSummaryHoverService');

export interface ISessionSummaryHoverProvider {
	readonly onDidChange: Event<void>;
	provideSessionSummaryHoverData(resource: URI): ISessionSummaryHoverData | undefined;
}

export interface ISessionSummaryHoverService {
	readonly _serviceBrand: undefined;
	registerProvider(provider: ISessionSummaryHoverProvider): IDisposable;
	/** Resolves cached metadata immediately and keeps the card current until its hover is closed. */
	createHoverElement(resource: URI, token: CancellationToken, document: Document): HTMLElement | undefined;
}

export class SessionSummaryHoverService extends Disposable implements ISessionSummaryHoverService {
	declare readonly _serviceBrand: undefined;
	private readonly providers = this._register(new DisposableMap<ISessionSummaryHoverProvider, DisposableStore>());

	public registerProvider(provider: ISessionSummaryHoverProvider): IDisposable {
		this.assertNotDisposed();
		if (this.providers.has(provider)) {
			throw new Error('Session summary hover provider is already registered');
		}
		this.providers.set(provider, new DisposableStore());
		return toDisposable(() => this.providers.deleteAndDispose(provider));
	}

	public createHoverElement(resource: URI, token: CancellationToken, document: Document): HTMLElement | undefined {
		if (token.isCancellationRequested) {
			return undefined;
		}
		for (const [provider, cards] of [...this.providers].reverse()) {
			const data = provider.provideSessionSummaryHoverData(resource);
			if (!data) {
				continue;
			}
			const lifetime = cards.add(new DisposableStore());
			lifetime.add(token.onCancellationRequested(() => {
				if (cards.delete(lifetime)) {
					lifetime.dispose();
				}
			}));
			const request = lifetime.add(new DisposableStore());
			const widget = new SessionSummaryHoverWidget(document, data, cancelOnDispose(request));
			let previous: ISessionSummaryHoverData | undefined = data;
			lifetime.add(provider.onDidChange(() => {
				const next = provider.provideSessionSummaryHoverData(resource);
				if (next?.title === previous?.title && next?.detailsSourceKey === previous?.detailsSourceKey
					&& equals(next?.details, previous?.details)) {
					return;
				}
				previous = next;
				request.clear();
				widget.update(next, cancelOnDispose(request));
			}));
			return widget.domNode;
		}
		return undefined;
	}
}
