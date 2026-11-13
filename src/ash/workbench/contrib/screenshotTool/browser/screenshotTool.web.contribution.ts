import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IScreenshotToolService } from './screenshotTool.js';
import { ScreenshotToolService } from './screenshotToolService.js';

registerSingleton(IScreenshotToolService, ScreenshotToolService, InstantiationType.Delayed);
