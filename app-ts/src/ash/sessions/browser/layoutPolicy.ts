import type { SessionsLayoutStyle } from '../common/configuration.js';
import { SESSION_SIDEBAR_DEFAULT_WIDTH, SESSION_AUXILIARYBAR_DEFAULT_WIDTH } from '../common/layoutConstants.js';
import { EDITOR_PART_DEFAULT_WIDTH } from './parts/editor/editorPartSizing.js';

/** Appearance geometry shared by every Sessions page; page identity never changes these metrics. */
export class SessionsLayoutPolicy {
	public getPartSizes(): { readonly sideBarSize: number; readonly auxiliaryBarSize: number; readonly editorSize: number; readonly panelSize: number } {
		return { sideBarSize: SESSION_SIDEBAR_DEFAULT_WIDTH, auxiliaryBarSize: SESSION_AUXILIARYBAR_DEFAULT_WIDTH, editorSize: EDITOR_PART_DEFAULT_WIDTH, panelSize: 240 };
	}

	public getFrameMetrics(style: SessionsLayoutStyle): { readonly leftEdge: number; readonly rightEdge: number } {
		return style === 'modern' ? { leftEdge: 6, rightEdge: 4 } : { leftEdge: 0, rightEdge: 0 };
	}
}
