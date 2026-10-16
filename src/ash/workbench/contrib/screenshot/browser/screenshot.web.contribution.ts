import './screenshot.contribution.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IScreenshotService } from '../common/screenshot.js';
import { BrowserScreenshotService } from './browserScreenshotService.js';

registerSingleton(IScreenshotService, BrowserScreenshotService, InstantiationType.Delayed);
