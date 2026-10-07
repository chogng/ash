import { type IDisposable } from '../../../../base/common/lifecycle.js';
import { type IDocumentDiffItem } from './model.js';

/** Supplies Workbench actions without making the editor depend on Workbench modules. */
export interface IWorkbenchUIElementFactory {
	createItemActions(container: HTMLElement, item: IDocumentDiffItem): IDisposable;
}
