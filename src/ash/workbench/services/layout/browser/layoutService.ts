import type { IDimension } from '../../../../base/browser/dom.js';
import type { Direction } from '../../../../base/browser/ui/grid/grid.js';
import type { Event } from '../../../../base/common/event.js';
import type { ISize } from '../../../../base/common/layout.js';
import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import type { WorkbenchLayoutStyle } from '../../../common/configuration.js';

export const workbenchPartIds = [
	'titlebar',
	'banner',
	'statusbar',
	'activitybar',
	'sidebar',
	'auxiliarybar',
	'agentSidebar',
	'editor',
	'panel',
	'chat',
] as const;
export type WorkbenchPartId = typeof workbenchPartIds[number];

export enum Position {
	LEFT,
	RIGHT,
	BOTTOM,
	TOP,
}

export function isHorizontal(position: Position): boolean {
	return position === Position.BOTTOM || position === Position.TOP;
}

export function positionToString(position: Position): string {
	switch (position) {
		case Position.LEFT: return 'left';
		case Position.RIGHT: return 'right';
		case Position.BOTTOM: return 'bottom';
		case Position.TOP: return 'top';
	}
}

export function positionFromString(value: string): Position {
	switch (value) {
		case 'left': return Position.LEFT;
		case 'right': return Position.RIGHT;
		case 'top': return Position.TOP;
		default: return Position.BOTTOM;
	}
}

export interface WorkbenchPartVisibilityChangeEvent {
	readonly partId: WorkbenchPartId;
	readonly visible: boolean;
}

/** Container geometry and Part operations share one window-scoped layout owner. */
export interface IWorkbenchLayoutService extends ILayoutService {
	layout(dimension?: IDimension): void;
	setLayoutStyle(style: WorkbenchLayoutStyle): void;

	readonly onDidChangePartVisibility: Event<WorkbenchPartVisibilityChangeEvent>;
	isPartVisible(partId: WorkbenchPartId): boolean;
	showPart(partId: WorkbenchPartId): void;
	hidePart(partId: WorkbenchPartId): void;

	hasFocus(partId: WorkbenchPartId): boolean;
	getVisibleNeighborPart(partId: WorkbenchPartId, direction: Direction): WorkbenchPartId | undefined;

	getSideBarPosition(): Position;

	readonly onDidChangePanelPosition: Event<string>;
	getPanelPosition(): Position;
	setPanelPosition(position: Position): void;
	isPanelMaximized(): boolean;
	/** Shows and maximizes the Panel, or restores the Editor and the previous Panel size. */
	toggleMaximizedPanel(): void;

	isEditorHiddenByChat(): boolean;
	/** A visible Chat can take the Editor area. Restoring the Editor restores Chat's previous width. */
	setEditorHiddenByChat(hidden: boolean): void;

	readonly onDidChangeAuxiliaryBarMaximized: Event<void>;
	isAuxiliaryBarMaximized(): boolean;
	toggleMaximizedAuxiliaryBar(): void;
	/** Temporarily gives the Auxiliary Bar the content area. Returns whether the maximization state changed. */
	setAuxiliaryBarMaximized(maximized: boolean): boolean;

	/** For a hidden Part, returns its retained size for when it is shown again. */
	getPartSize(partId: WorkbenchPartId): ISize;
	/** Requests a target size in pixels, subject to Grid constraints. */
	setPartSize(partId: WorkbenchPartId, size: ISize): void;
}

export const IWorkbenchLayoutService = refineServiceDecorator<ILayoutService, IWorkbenchLayoutService>(ILayoutService);
