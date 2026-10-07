import type { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { Command } from '../../../../editor/common/languages.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const TimelinePaneId = 'timeline';

export interface TimelineItem {
	readonly handle: string;
	readonly source: string;
	readonly id?: string;
	readonly label: string;
	readonly description?: string;
	readonly tooltip?: string;
	readonly timestamp: number;
	readonly command?: Command;
	readonly contextValue?: string;
}

export interface TimelineChangeEvent {
	readonly id: string;
	readonly uri: URI | undefined;
	readonly reset: boolean;
}

export interface TimelineOptions {
	readonly cursor?: string;
	readonly limit?: number | { readonly timestamp: number; readonly id?: string; };
	readonly resetCache?: boolean;
	readonly cacheResults?: boolean;
}

export interface Timeline {
	readonly source: string;
	readonly items: readonly TimelineItem[];
	readonly paging?: { readonly cursor: string | undefined; };
}

export interface TimelineSource {
	readonly id: string;
	readonly label: string;
}

export interface TimelineProviderDescriptor extends TimelineSource {
	readonly scheme: string | readonly string[];
}

/** Registration owns subscriptions and requests; the contribution retains ownership of the provider. */
export interface TimelineProvider extends TimelineProviderDescriptor, IDisposable {
	readonly onDidChange?: Event<TimelineChangeEvent>;
	provideTimeline(uri: URI, options: TimelineOptions, token: CancellationToken): Promise<Timeline | undefined>;
}

export interface TimelineProvidersChangeEvent {
	readonly added?: readonly string[];
	readonly removed?: readonly string[];
}

export interface TimelineRequest {
	readonly result: Promise<Timeline | undefined>;
	readonly options: TimelineOptions;
	readonly source: string;
	readonly tokenSource: CancellationTokenSource;
	readonly uri: URI;
}

export interface ITimelineService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeProviders: Event<TimelineProvidersChangeEvent>;
	readonly onDidChangeTimeline: Event<TimelineChangeEvent>;
	readonly onDidChangeUri: Event<URI>;
	registerTimelineProvider(provider: TimelineProvider): IDisposable;
	unregisterTimelineProvider(id: string): void;
	getSources(): TimelineSource[];
	getTimeline(id: string, uri: URI, options: TimelineOptions, tokenSource: CancellationTokenSource): TimelineRequest | undefined;
	setUri(uri: URI): void;
}

export const ITimelineService = createDecorator<ITimelineService>('timeline');
