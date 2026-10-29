import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceExtensionsConfigService } from './workspaceExtensionsConfig.js';
import {
	extensionRecommendationKey,
	type IExtensionIgnoredRecommendationsService,
} from './extensionRecommendations.js';

const ignoredKey = 'extensionsAssistant/ignored_recommendations';

/** Global user choices are stored once; workspace exclusions remain owned by their configuration files. */
export class ExtensionIgnoredRecommendationsService
	extends Disposable
	implements IExtensionIgnoredRecommendationsService
{
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeIgnoredRecommendations = this.changed.event;
	private readonly globalChanged = this._register(new Emitter<{ extensionId: string; isRecommended: boolean }>());
	public readonly onDidChangeGlobalIgnoredRecommendation = this.globalChanged.event;
	private workspaceIgnored: readonly string[] = [];
	private generation = 0;

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@IWorkspaceExtensionsConfigService private readonly configs: IWorkspaceExtensionsConfigService,
	) {
		super();
		this._register(
			storage.onDidChangeValue(event => {
				if (event.scope === StorageScope.PROFILE && event.key === ignoredKey) {
					this.changed.fire();
				}
			}),
		);
		this._register(
			configs.onDidChangeExtensionsConfigs(() => {
				this.workspaceIgnored = [];
				this.changed.fire();
				void this.readWorkspace();
			}),
		);
		void this.readWorkspace();
	}

	public get globalIgnoredRecommendations(): readonly string[] {
		try {
			const value: unknown = JSON.parse(this.storage.get(ignoredKey, StorageScope.PROFILE, '[]'));
			return Array.isArray(value)
				? [
						...new Set(
							value
								.slice(0, 1000)
								.filter(
									(id): id is string =>
										typeof id === 'string' && /^[a-z0-9][a-z0-9_.@/-]{0,255}$/iu.test(id),
								)
								.map(extensionRecommendationKey),
						),
					]
				: [];
		} catch {
			return [];
		}
	}
	public get ignoredRecommendations(): readonly string[] {
		return [...new Set([...this.globalIgnoredRecommendations, ...this.workspaceIgnored])];
	}
	public toggleGlobalIgnoredRecommendation(extensionId: string, ignore: boolean): void {
		const id = extensionRecommendationKey(extensionId);
		const current = this.globalIgnoredRecommendations;
		if (current.includes(id) === ignore) {
			return;
		}
		this.storage.store(
			ignoredKey,
			JSON.stringify(ignore ? [...current, id] : current.filter(candidate => candidate !== id)),
			StorageScope.PROFILE,
			StorageTarget.USER,
		);
		this.globalChanged.fire({ extensionId: id, isRecommended: !ignore });
	}
	private async readWorkspace(): Promise<void> {
		const generation = ++this.generation;
		try {
			const configs = await this.configs.getExtensionsConfigs();
			if (this.isDisposed || generation !== this.generation) {
				return;
			}
			this.workspaceIgnored = configs
				.flatMap(config => config.unwantedRecommendations)
				.map(extensionRecommendationKey);
		} catch {
			/* A workspace transition may cancel the old configuration read. */
		}
	}
}
