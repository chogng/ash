import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IExtensionRecommendationsService } from '../../../services/extensionRecommendations/common/extensionRecommendations.js';
import '../../../services/extensionRecommendations/common/workspaceExtensionsConfig.js';
import { ExtensionRecommendationsService } from './extensionRecommendationsService.js';

registerSingleton(IExtensionRecommendationsService, ExtensionRecommendationsService, InstantiationType.Delayed);
