import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IScreenshotToolService } from '../browser/screenshotTool.js';
import { NativeScreenshotToolService } from './nativeScreenshotToolService.js';
import { IScreenCaptureSetupService, ScreenCaptureSetupService } from './screenCaptureSetup.js';

registerSingleton(IScreenshotToolService, NativeScreenshotToolService, InstantiationType.Delayed);
registerSingleton(IScreenCaptureSetupService, ScreenCaptureSetupService, InstantiationType.Delayed);
