import type { IDimension } from '../../../../base/browser/dom.js';
import type { Icon } from '../../../../base/common/icon.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { CreatorMode } from '../common/creator.js';

export interface ICreatorWorkspace extends IDisposable {
	readonly domNode: HTMLElement;
	readonly usesCanvasPanels: boolean;
	create(container: HTMLElement): void;
	setVisible(visible: boolean): void;
	layout(dimension: IDimension): void;
	focus(): void;
	getAccessibleContent(): string;
}

export interface CreatorModeContribution {
	readonly id: CreatorMode;
	readonly title: string;
	readonly description: string;
	readonly icon: Icon;
	readonly help: string;
	create(instantiation: IInstantiationService, ownerDocument: Document): ICreatorWorkspace;
}

/** Modes register at the product entry; the page consumes contracts without importing mode implementations. */
export const CreatorModes = new Map<CreatorMode, CreatorModeContribution>();
