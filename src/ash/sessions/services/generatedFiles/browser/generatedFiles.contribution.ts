import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IGeneratedFilesService } from '../common/generatedFilesService.js';
import { GeneratedFileAutoSave } from './generatedFileAutoSave.js';
import { GeneratedFilesService } from './generatedFilesService.js';

// Chat models and generated-resource working copies exist in both Code and Sessions windows.
registerSingleton(IGeneratedFilesService, GeneratedFilesService, InstantiationType.Delayed);
registerWorkbenchContribution('sessions.generatedFileAutoSave', WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(GeneratedFileAutoSave));
