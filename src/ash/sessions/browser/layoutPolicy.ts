import type { SessionsLayoutStyle } from '../common/configuration.js';
import { AGENTS_FLOATING_PANEL_GAP } from '../common/sizes.js';

export interface IPartSizeDefaults {
	readonly sideBarSize: number;
	readonly auxiliaryBarSize: number;
	readonly panelSize: number;
	readonly sessionsWidth: number;
}

export interface IPartVisibilityDefaults {
	readonly sidebar: boolean;
	readonly auxiliaryBar: boolean;
	readonly panel: boolean;
	readonly sessions: boolean;
	readonly editor: boolean;
}

/** Appearance geometry shared by every Sessions page; page identity never changes these metrics. */
export class SessionsLayoutPolicy {
	public getPartVisibilityDefaults(): IPartVisibilityDefaults {
		return { sidebar: true, auxiliaryBar: true, panel: false, sessions: true, editor: false };
	}

	public getPartSizes(width: number, _height: number): IPartSizeDefaults {
		return { sideBarSize: 300, auxiliaryBarSize: 340, panelSize: 300, sessionsWidth: width - 300 };
	}

	public getFrameMetrics(style: SessionsLayoutStyle): { readonly leftEdge: number; readonly rightEdge: number; } {
		return style === 'modern' ? { leftEdge: 6, rightEdge: AGENTS_FLOATING_PANEL_GAP } : { leftEdge: 0, rightEdge: 0 };
	}
}
