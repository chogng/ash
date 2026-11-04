export interface IPartSizeDefaults {
	readonly sideBarSize: number;
	readonly auxiliaryBarSize: number;
	readonly sessionsWidth: number;
}

export interface IPartVisibilityDefaults {
	readonly sidebar: boolean;
	readonly auxiliaryBar: boolean;
	readonly sessions: boolean;
	readonly editor: boolean;
}

/** Appearance geometry shared by every Sessions page; page identity never changes these metrics. */
export class SessionsLayoutPolicy {
	public getPartVisibilityDefaults(): IPartVisibilityDefaults {
		return { sidebar: true, auxiliaryBar: true, sessions: true, editor: false };
	}

	public getPartSizes(width: number, _height: number): IPartSizeDefaults {
		return { sideBarSize: 300, auxiliaryBarSize: 340, sessionsWidth: width - 300 };
	}
}
