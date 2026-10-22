import { type IDisposable } from '../../../../base/common/lifecycle.js';
import { type IDocumentDiffItem } from './model.js';

/** Supplies themed resource labels and actions without an editor dependency on Workbench modules. */
export interface IWorkbenchUIElementFactory {
	createResourceLabel?(container: HTMLElement, item: IDocumentDiffItem): IDisposable;
	createItemActions(container: HTMLElement, item: IDocumentDiffItem): IDisposable;
}
