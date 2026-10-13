/** Browser signals are observations, not a direct OS billing-status query. */
export interface NetworkInformation extends EventTarget {
	readonly saveData?: boolean;
	readonly metered?: boolean;
}

export interface NavigatorWithConnection {
	readonly connection?: NetworkInformation;
}
