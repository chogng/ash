export const workbenchPartIds = ["titlebar", "statusbar", "activitybar", "sidebar", "auxiliarybar", "agentSidebar", "editor", "panel"] as const;

export type WorkbenchPartId = typeof workbenchPartIds[number];

/** Describes a Workbench Part whose effective visibility changed. */
export interface WorkbenchPartVisibilityChangeEvent {
	readonly partId: WorkbenchPartId;
	readonly visible: boolean;
}
