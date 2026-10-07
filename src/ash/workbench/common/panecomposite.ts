import type { IViewPaneContainer } from './views.js';
import type { IComposite } from './composite.js';

/** Retained view container activated by a workbench Part. */
export interface IPaneComposite extends IComposite, IViewPaneContainer {
	readonly title: string;
	getControl(): IViewPaneContainer;
}
