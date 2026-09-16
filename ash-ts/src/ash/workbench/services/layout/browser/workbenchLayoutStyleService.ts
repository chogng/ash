import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { WorkbenchLayoutStyle } from '../../../common/configuration.js';

/** Applies one selected presentation to the Workbench layout owner. */
export interface IWorkbenchLayoutStyleService {
	readonly container: HTMLElement;
	setLayoutStyle(style: WorkbenchLayoutStyle): void;
}

export const IWorkbenchLayoutStyleService = createServiceIdentifier<IWorkbenchLayoutStyleService>('workbenchLayoutStyleService');
