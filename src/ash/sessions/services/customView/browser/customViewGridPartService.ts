import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ICustomViewDescriptor } from './customView.js';

export interface ICustomViewGridPartService {
	setView(descriptor: ICustomViewDescriptor | undefined): void;
	focusActiveView(): void;
}

export const ICustomViewGridPartService = createServiceIdentifier<ICustomViewGridPartService>('customViewGridPartService');
