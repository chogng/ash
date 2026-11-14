import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IArtifactCatalogService } from '../common/artifactCatalogService.js';
import { ArtifactCatalogService } from './artifactCatalogService.js';

// Chat models and artifact working copies consume the same profile catalog in both window modes.
registerSingleton(IArtifactCatalogService, ArtifactCatalogService, InstantiationType.Delayed);
