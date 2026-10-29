import { createDecorator, type IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ITitlebarPart, IAuxiliaryTitlebarPart } from '../../../browser/parts/titlebar/titlebarPart.js';
import type { IEditorGroupsContainer } from '../../editor/common/editorGroupsService.js';
import type { WindowTitle } from '../../../browser/parts/titlebar/windowTitle.js';

export const ITitleService = createDecorator<ITitleService>('titleService');

/** Shares the main window's resolved title and owns its titlebar lifecycle. */
export interface ITitleService extends ITitlebarPart {
	readonly _serviceBrand: undefined;
	readonly windowTitle: WindowTitle;
	getPart(container: HTMLElement): ITitlebarPart;
	createAuxiliaryTitlebarPart(container: HTMLElement, editorGroupsContainer: IEditorGroupsContainer, instantiationService: IInstantiationService): IAuxiliaryTitlebarPart;
}
