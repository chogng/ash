import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ArtifactTableDrafts, IArtifactTableDrafts } from './artifactTableDrafts.js';
import { registerTableArtifactCatalog } from './tableArtifactWorkspaces.js';

registerSingleton(IArtifactTableDrafts, ArtifactTableDrafts, InstantiationType.Delayed);
registerTableArtifactCatalog('sheet');
