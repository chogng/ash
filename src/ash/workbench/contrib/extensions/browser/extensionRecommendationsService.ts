import { localize } from '../../../../nls.js';
import { IWorkspaceExtensionsConfigService } from '../../../services/extensionRecommendations/common/workspaceExtensionsConfig.js';
import { ExtensionRecommendationReason, type ExtensionRecommendationsSnapshot, type IExtensionRecommendationsService } from '../../../services/extensionRecommendations/common/extensionRecommendations.js';

/** Combines workspace declarations and exclusions without owning package installation state. */
export class ExtensionRecommendationsService implements IExtensionRecommendationsService {
	public readonly onDidChangeRecommendations;
	constructor(@IWorkspaceExtensionsConfigService private readonly configs: IWorkspaceExtensionsConfigService) { this.onDidChangeRecommendations = configs.onDidChangeExtensionsConfigs; }
	public refresh(): void { this.configs.refresh(); }
	public async getWorkspaceRecommendations(): Promise<ExtensionRecommendationsSnapshot> {
		const configs = await this.configs.getExtensionsConfigs();
		const excluded = new Set(configs.flatMap(config => config.unwantedRecommendations));
		const ids = new Set(configs.flatMap(config => config.recommendations));
		return {
			recommendations: [...ids].filter(id => !excluded.has(id)).map(extensionId => ({ extensionId, reason: { reasonId: ExtensionRecommendationReason.Workspace, reasonText: localize({ bundle: 'ash.extensions', key: 'workspaceRecommendationReason' }, 'Recommended by this workspace') } })),
			resources: configs.map(config => config.resource),
			diagnostics: configs.flatMap(config => config.diagnostic ? [config.diagnostic] : []),
		};
	}
}
