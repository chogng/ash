import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IGeneratedFilesService } from '../common/generatedFilesService.js';
import { GeneratedFilesService } from './generatedFilesService.js';

// Chat models and generated-resource working copies exist in both Code and Sessions windows.
registerSingleton(IGeneratedFilesService, GeneratedFilesService, InstantiationType.Delayed);
