import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IArtifactAutoSaveService } from '../common/artifactAutoSaveService.js';
import { ArtifactAutoSaveService } from './artifactAutoSaveService.js';

registerSingleton(IArtifactAutoSaveService, ArtifactAutoSaveService, InstantiationType.Delayed);
registerWorkbenchContribution('sessions.artifactAutoSave', WorkbenchPhase.BlockRestore, accessor => {
	accessor.get(IArtifactAutoSaveService);
	return Disposable.None;
});
