import type { SessionsLayoutStyle } from '../common/configuration.js';

/** Appearance geometry shared by every Sessions page; page identity never changes these metrics. */
export class SessionsLayoutPolicy {
	public getFrameMetrics(style: SessionsLayoutStyle): { readonly leftEdge: number; readonly rightEdge: number } {
		return style === 'modern' ? { leftEdge: 6, rightEdge: 4 } : { leftEdge: 0, rightEdge: 0 };
	}
}
