import { BaseRenderStrategy } from './baseRenderStrategy.js';

export class ViewportRenderStrategy extends BaseRenderStrategy {
	public readonly type = 'viewport';
	protected readonly bufferLabel = 'Ash viewport GPU cells';
	protected firstRow(): number { return 0; }
	protected rowStride(longestRow: number): number {
		// A short edit can grow within its current row without moving subsequent rows.
		return 2 ** Math.ceil(Math.log2(Math.max(1, longestRow)));
	}
}
