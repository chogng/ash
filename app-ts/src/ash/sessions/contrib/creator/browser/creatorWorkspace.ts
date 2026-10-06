import type { IDimension } from '../../../../base/browser/dom.js';
import type { Icon } from '../../../../base/common/icon.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { CreatorMode } from '../common/creator.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { CreatorWorkspaceView } from './creatorViews.js';

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

export const CREATOR_NAVIGATION_CONTAINER_ID = 'sessions.creator.navigation';

/** Workspace content is created lazily; entries are registered before the editor opens. */
export const CreatorModes = new Map<CreatorMode, CreatorModeContribution>();

export function registerCreatorMode(contribution: CreatorModeContribution): void {
	CreatorModes.set(contribution.id, contribution);
	SessionsViewRegistry.registerStaticViews(CREATOR_NAVIGATION_CONTAINER_ID, [{
		id: `${CREATOR_NAVIGATION_CONTAINER_ID}.${contribution.id}`,
		title: contribution.title,
		ctorDescriptor: new SyncDescriptor(CreatorWorkspaceView, [contribution]),
		canToggleVisibility: false,
	}]);
}
