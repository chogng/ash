import { type ViewportData } from '../../../common/viewLayout/viewLinesViewportData.js';
import { BaseRenderStrategy } from './baseRenderStrategy.js';

export class FullFileRenderStrategy extends BaseRenderStrategy {
	public static readonly maxSupportedLines = 3_000;
	public static readonly maxSupportedColumns = 200;
	public readonly type = 'fullfile';
	protected readonly bufferLabel = 'Ash full-file GPU cells';
	protected firstRow(viewport: ViewportData): number { return viewport.startLineNumber - 1; }
	protected rowStride(): number { return FullFileRenderStrategy.maxSupportedColumns; }
}
