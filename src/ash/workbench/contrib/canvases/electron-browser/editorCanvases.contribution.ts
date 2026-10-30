import './canvases.contribution.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ICanvasContextService } from '../common/canvas.js';
import { EditorCanvasContextService } from './editorCanvasContextService.js';

registerSingleton(ICanvasContextService, EditorCanvasContextService, InstantiationType.Delayed);
