import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	IFileService,
	FileSystemProviderErrorCode,
	toFileSystemProviderErrorCode,
} from '../../../../platform/files/common/files.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

export interface WorkspaceExtensionsConfig {
	readonly resource: URI;
	readonly recommendations: readonly string[];
	readonly unwantedRecommendations: readonly string[];
	readonly diagnostic?: string;
}

export interface IWorkspaceExtensionsConfigService {
	readonly onDidChangeExtensionsConfigs: Event<void>;
	getExtensionsConfigs(): Promise<readonly WorkspaceExtensionsConfig[]>;
	refresh(): void;
}

export const IWorkspaceExtensionsConfigService = createServiceIdentifier<IWorkspaceExtensionsConfigService>(
	'workspaceExtensionsConfigService',
);

/** Reads workspace declarations; invalid edits retain the last valid declaration in that scope. */
export class WorkspaceExtensionsConfigService extends Disposable implements IWorkspaceExtensionsConfigService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeExtensionsConfigs = this.changed.event;
	private readonly watches = this._register(new DisposableMap<string>());
	private readonly validConfigs = new Map<string, WorkspaceExtensionsConfig>();
	private generation = 0;
	private pending: Promise<readonly WorkspaceExtensionsConfig[]> | undefined;

	constructor(
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IFileService private readonly files: IFileService,
		@IUriIdentityService private readonly identity: IUriIdentityService,
	) {
		super();
		this._register(
			workspace.onDidChangeWorkspace(() => {
				this.watches.clearAndDisposeAll();
				this.validConfigs.clear();
				this.refresh();
			}),
		);
		this._register(
			files.onDidChangeFileSystemProviderRegistrations(() => {
				this.watches.clearAndDisposeAll();
				this.refresh();
			}),
		);
		this._register(
			files.onDidChangeFiles(event => {
				if (
					!event.resources ||
					this.resources().some(({ resource }) =>
						event.resources!.some(changed => identity.extUri.isEqualOrParent(resource, changed)),
					)
				) {
					this.refresh();
				}
			}),
		);
	}

	public refresh(): void {
		++this.generation;
		this.pending = undefined;
		this.changed.fire();
	}

	public getExtensionsConfigs(): Promise<readonly WorkspaceExtensionsConfig[]> {
		this.assertNotDisposed();
		if (!this.pending) {
			const generation = this.generation;
			this.pending = Promise.all(
				this.resources().map(async ({ resource, isWorkspaceFile }) => {
					const key = this.identity.extUri.getComparisonKey(resource);
					let config: WorkspaceExtensionsConfig;
					try {
						if (!this.watches.has(key) && this.files.hasProvider(resource)) {
							this.watches.set(key, this.files.watch(resource));
						}
						const file = await this.files.readFile(resource);
						if (file.content.length > 2 * 1024 * 1024) {
							throw new Error(
								localize(
									{ bundle: 'ash.extensions', key: 'recommendationsTooLarge' },
									'The recommendations file exceeds 2 MB.',
								),
							);
						}
						const document = parseJsonc(file.content);
						if (!document || typeof document !== 'object' || Array.isArray(document)) {
							throw new Error(
								localize(
									{ bundle: 'ash.extensions', key: 'recommendationsObject' },
									'The recommendations configuration must be an object.',
								),
							);
						}
						const field = isWorkspaceFile ? (document as Record<string, unknown>).extensions : document;
						const value = field === undefined ? {} : field;
						if (!value || typeof value !== 'object' || Array.isArray(value)) {
							throw new Error(
								localize(
									{ bundle: 'ash.extensions', key: 'recommendationsObject' },
									'The recommendations configuration must be an object.',
								),
							);
						}
						const record = value as Record<string, unknown>;
						config = {
							resource,
							recommendations: this.readIds(record.recommendations),
							unwantedRecommendations: this.readIds(record.unwantedRecommendations),
						};
					} catch (error) {
						if (
							toFileSystemProviderErrorCode(error instanceof Error ? error : undefined) ===
							FileSystemProviderErrorCode.FileNotFound
						) {
							config = { resource, recommendations: [], unwantedRecommendations: [] };
						} else {
							config = {
								...(this.validConfigs.get(key) ?? {
									resource,
									recommendations: [],
									unwantedRecommendations: [],
								}),
								diagnostic: localize(
									{ bundle: 'ash.extensions', key: 'recommendationsInvalid' },
									'Could not read recommendations from {0}: {1}',
									resource.toString(),
									error instanceof Error ? error.message : String(error),
								),
							};
						}
					}
					if (this.isDisposed || generation !== this.generation) {
						throw new CancellationError();
					}
					if (!config.diagnostic) {
						this.validConfigs.set(key, config);
					}
					return config;
				}),
			);
		}
		return this.pending;
	}

	private resources(): readonly { readonly resource: URI; readonly isWorkspaceFile: boolean }[] {
		const workspace = this.workspace.getWorkspace();
		return [
			...(workspace.configuration ? [{ resource: workspace.configuration, isWorkspaceFile: true }] : []),
			...workspace.folders.map(folder => ({
				resource: URI.joinPath(folder.uri, '.ash', 'extensions.json'),
				isWorkspaceFile: false,
			})),
		];
	}

	private readIds(value: unknown): readonly string[] {
		if (value === undefined) {
			return [];
		}
		if (
			!Array.isArray(value) ||
			value.length > 1000 ||
			value.some(
				id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9_.@/-]{0,255}$/iu.test(id) || id.includes('..'),
			)
		) {
			throw new Error(
				localize(
					{ bundle: 'ash.extensions', key: 'recommendationsIds' },
					'Recommendations must be arrays of at most 1000 extension IDs.',
				),
			);
		}
		return [...new Set((value as string[]).map(id => id.toLowerCase()))];
	}
}

registerSingleton(IWorkspaceExtensionsConfigService, WorkspaceExtensionsConfigService, InstantiationType.Delayed);
