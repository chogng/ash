import type { IViewPaneContainer } from './views.js';

/** Retained view container activated by a workbench Part. */
export interface IPaneComposite extends IViewPaneContainer {
	readonly title: string;
}
