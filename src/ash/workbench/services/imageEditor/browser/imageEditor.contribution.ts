import { BrowserImageEditorService } from './browserImageEditorService.js';
import { IImageEditorService } from '../common/imageEditorService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
registerSingleton(IImageEditorService, BrowserImageEditorService, InstantiationType.Delayed);
