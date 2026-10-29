import type { IObservable } from '../../../../base/common/observable.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ICanvasDefinition } from '../../../../workbench/contrib/canvases/common/canvas.js';

export const ISessionCanvasRegistryService = createServiceIdentifier<ISessionCanvasRegistryService>('sessionCanvasRegistryService');

export interface ISessionCanvasRegistryService {
	readonly availableCanvases: IObservable<readonly ICanvasDefinition[]>;
	openCanvas(canvas: ICanvasDefinition): Promise<void>;
}
