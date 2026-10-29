import type { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { CancellationError, isCancellationError } from '../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

/** Resource kinds currently discoverable through Ash's verified package catalog. */
export const CustomizationMarketplaceMediaType = {
	Skill: 'application/ai-skill',
	McpServer: 'application/mcp-server+json',
} as const;

export type CustomizationMarketplaceMediaType =
	(typeof CustomizationMarketplaceMediaType)[keyof typeof CustomizationMarketplaceMediaType];

/** An inert catalog selection. Installation and permissions remain with the package authority. */
export type CustomizationMarketplaceInstallation = {
	readonly kind: 'providerCatalog';
	readonly resourceKind: 'skill' | 'mcp';
	readonly selectionId: string;
};

export interface ICustomizationMarketplaceResource {
	readonly sourceId: string;
	readonly identifier: string;
	readonly displayName: string;
	readonly description: string;
	readonly mediaType: CustomizationMarketplaceMediaType;
	readonly capabilities: readonly string[];
	readonly version: string;
	readonly installation: CustomizationMarketplaceInstallation;
}

/** Catalog identities are scoped to their source and exact version. */
export function getCustomizationMarketplaceResourceKey(
	resource: Pick<ICustomizationMarketplaceResource, 'sourceId' | 'identifier' | 'version'>,
): string {
	return JSON.stringify([resource.sourceId, resource.identifier, resource.version]);
}

export interface ICustomizationMarketplaceQuery {
	readonly query?: string;
	readonly mediaType?: CustomizationMarketplaceMediaType;
	readonly sourceIds?: readonly string[];
	/** Maximum combined result count in this page. */
	readonly pageSize?: number;
	readonly cursor?: ICustomizationMarketplaceCursor;
}

export interface ICustomizationMarketplaceCursor {
	readonly token: string;
}
export interface ICustomizationMarketplaceRequest extends ICustomizationMarketplaceQuery {
	readonly sourceIds: readonly string[];
}

export interface ICustomizationMarketplaceSourceError {
	readonly sourceId: string;
	readonly message: string;
}

export interface ICustomizationMarketplacePage {
	readonly items: readonly ICustomizationMarketplaceResource[];
	readonly total?: number;
	readonly nextCursor?: ICustomizationMarketplaceCursor;
	readonly sourceErrors?: readonly ICustomizationMarketplaceSourceError[];
}

export interface ICustomizationMarketplaceSourceQuery extends Omit<
	ICustomizationMarketplaceQuery,
	'cursor' | 'sourceIds'
> {
	readonly cursor?: string;
}
export interface ICustomizationMarketplaceSourcePage {
	readonly items: readonly ICustomizationMarketplaceResource[];
	readonly total?: number;
	readonly nextCursor?: string;
}
export interface ICustomizationMarketplaceProvider {
	readonly id: string;
	readonly sourceId: string;
	query(
		options: ICustomizationMarketplaceSourceQuery,
		token: CancellationToken,
	): Promise<ICustomizationMarketplaceSourcePage>;
}

export interface ICustomizationMarketplaceSourceInfo {
	readonly id: string;
	readonly displayName: string;
	readonly enablementSetting: string;
	/** Availability comes from the backend registry authority. */
	readonly enabled?: boolean;
}

export interface ICustomizationMarketplaceService {
	readonly sources: readonly ICustomizationMarketplaceSourceInfo[];
	readonly allSources: readonly ICustomizationMarketplaceSourceInfo[];
	readonly onDidChangeSources: Event<void>;
	/** Cancels the caller's interest in shared reads; it does not cancel a package installation. */
	query(options: ICustomizationMarketplaceQuery, token: CancellationToken): Promise<ICustomizationMarketplacePage>;
}

export const ICustomizationMarketplaceService = createServiceIdentifier<ICustomizationMarketplaceService>(
	'customizationMarketplaceService',
);

interface Feed {
	readonly provider: ICustomizationMarketplaceProvider;
	readonly cursors: Set<string>;
	buffer: ICustomizationMarketplaceResource[];
	cursor?: string;
	exhausted: boolean;
	total?: number;
	error?: string;
}

interface Continuation {
	readonly identity: string;
	readonly expires: number;
	readonly seen: Set<string>;
	readonly feeds: Feed[];
}

/** Owns only window-local continuations, never durable catalogs, installation or provider trust. */
export class CustomizationMarketplaceService extends Disposable {
	private readonly pages = new Map<string, Continuation>();
	private readonly shutdown = new CancellationTokenSource();

	constructor(private readonly providers: readonly ICustomizationMarketplaceProvider[]) {
		super();
		this._register(
			toDisposable(() => {
				this.shutdown.dispose(true);
				this.pages.clear();
			}),
		);
		if (
			providers.some(provider => !provider.id || !provider.sourceId) ||
			new Set(providers.map(provider => provider.id)).size !== providers.length
		) {
			throw new Error('Marketplace providers must have unique identifiers and a source.');
		}
	}

	async query(
		options: ICustomizationMarketplaceRequest,
		token: CancellationToken,
	): Promise<ICustomizationMarketplacePage> {
		if (token.isCancellationRequested || this.isDisposed) {
			throw new CancellationError();
		}
		const query = options.query?.trim() ?? '';
		const requestedSize = options.pageSize ?? 30;
		const pageSize = Math.min(requestedSize, 100);
		const sourceIds = [...options.sourceIds].sort();
		if (
			query.length > 4096 ||
			!Number.isSafeInteger(requestedSize) ||
			requestedSize <= 0 ||
			(options.mediaType !== undefined &&
				!Object.values(CustomizationMarketplaceMediaType).includes(options.mediaType)) ||
			new Set(sourceIds).size !== sourceIds.length ||
			sourceIds.some(id => !this.providers.some(provider => provider.sourceId === id))
		) {
			throw new Error(
				localize(
					{ bundle: 'ash.extensions', key: 'marketplaceInvalidQuery' },
					'The marketplace query is invalid.',
				),
			);
		}
		const identity = JSON.stringify([query, options.mediaType ?? null, pageSize, sourceIds]);
		for (const [id, page] of this.pages) {
			if (page.expires <= Date.now()) {
				this.pages.delete(id);
			}
		}
		const previous = options.cursor ? this.pages.get(options.cursor.token) : undefined;
		if (options.cursor && (!previous || previous.identity !== identity)) {
			throw new Error(
				localize(
					{ bundle: 'ash.extensions', key: 'marketplaceInvalidCursor' },
					'This marketplace page has expired or changed. Start a new search.',
				),
			);
		}
		// Consume the token once. An interrupted read can have advanced source cursors, so retry starts a fresh query.
		if (options.cursor) {
			this.pages.delete(options.cursor.token);
		}
		const page: Continuation = previous ?? {
			identity,
			expires: Date.now() + 30 * 60_000,
			seen: new Set(),
			feeds: this.providers
				.filter(provider => sourceIds.includes(provider.sourceId))
				.map(provider => ({ provider, buffer: [], cursors: new Set(), exhausted: false })),
		};
		using lifetime = new DisposableStore();
		const cancellation = new CancellationTokenSource(token);
		lifetime.add(toDisposable(() => cancellation.dispose(true)));
		lifetime.add(this.shutdown.token.onCancellationRequested(() => cancellation.cancel()));
		const items: ICustomizationMarketplaceResource[] = [];
		while (items.length < pageSize) {
			await raceCancellationError(
				Promise.all(
					page.feeds.map(async feed => {
						if (feed.buffer.length || feed.exhausted) {
							return;
						}
						try {
							const next = await feed.provider.query(
								{ query, mediaType: options.mediaType, pageSize, cursor: feed.cursor },
								cancellation.token,
							);
							if (
								next.items.length > pageSize ||
								(next.nextCursor !== undefined &&
									(feed.cursors.has(next.nextCursor) || !next.nextCursor)) ||
								(next.total !== undefined &&
									(!Number.isSafeInteger(next.total) || next.total < next.items.length))
							) {
								throw new Error(
									localize(
										{ bundle: 'ash.extensions', key: 'marketplaceInvalidSourcePage' },
										'Source {0} returned an invalid page.',
										feed.provider.sourceId,
									),
								);
							}
							if (next.nextCursor) {
								feed.cursors.add(next.nextCursor);
							}
							feed.buffer = [...next.items];
							feed.cursor = next.nextCursor;
							feed.exhausted = next.nextCursor === undefined;
							feed.total = next.total;
						} catch (error) {
							if (isCancellationError(error) || cancellation.token.isCancellationRequested) {
								throw new CancellationError();
							}
							feed.error = error instanceof Error ? error.message : String(error);
							feed.exhausted = true;
						}
					}),
				),
				cancellation.token,
			);
			let moved = false;
			for (const feed of page.feeds) {
				const item = feed.buffer.shift();
				if (!item) {
					continue;
				}
				moved = true;
				const key = getCustomizationMarketplaceResourceKey(item);
				if (!page.seen.has(key)) {
					page.seen.add(key);
					items.push(item);
				}
				if (items.length === pageSize) {
					break;
				}
			}
			if (!moved && page.feeds.every(feed => feed.exhausted)) {
				break;
			}
		}
		const errors = new Map(
			page.feeds.filter(feed => feed.error).map(feed => [feed.provider.sourceId, feed.error!]),
		);
		let nextCursor: ICustomizationMarketplaceCursor | undefined;
		if (page.feeds.some(feed => feed.buffer.length || !feed.exhausted)) {
			const id = generateUuid();
			this.pages.set(id, page);
			while (this.pages.size > 32) {
				this.pages.delete(this.pages.keys().next().value!);
			}
			nextCursor = { token: id };
		}
		const distinctSources = new Set(page.feeds.map(feed => feed.provider.sourceId)).size === page.feeds.length;
		const total =
			!errors.size && distinctSources && page.feeds.every(feed => feed.total !== undefined)
				? page.feeds.reduce((sum, feed) => sum + feed.total!, 0)
				: undefined;
		return {
			items,
			total,
			nextCursor,
			sourceErrors: [...errors].map(([sourceId, message]) => ({ sourceId, message })),
		};
	}
}
