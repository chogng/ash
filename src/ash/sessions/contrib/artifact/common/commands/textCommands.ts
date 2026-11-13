import { flattenArtifactCanvasShapes, type ArtifactCanvasShape } from '../model/artifactCanvasDocument.js';
import type { ArtifactCanvasModel } from '../model/artifactCanvasModel.js';
import { artifactCanvasTextSegments, formatArtifactCanvasText, replaceArtifactCanvasText, type ArtifactCanvasTextRun, type ArtifactCanvasTextShape, type ArtifactCanvasTextStyle } from '../model/artifactCanvasText.js';

/** Content and character formatting enter the same model transaction as all other edits. */
export class TextCommands {
	constructor(private readonly model: ArtifactCanvasModel) { }
	public get(id: string): ArtifactCanvasTextShape | undefined {
		const shape = flattenArtifactCanvasShapes(this.model.value.shapes).find(shape => shape.id === id);
		return shape?.kind === 'text' ? shape : undefined;
	}
	private edit(id: string, update: (shape: ArtifactCanvasTextShape) => ArtifactCanvasTextShape, undoGroup?: object): void {
		const visit = (shape: ArtifactCanvasShape): ArtifactCanvasShape => shape.id === id && shape.kind === 'text' ? update(shape) : shape.kind === 'frame' || shape.kind === 'group' ? { ...shape, children: shape.children.map(visit) } : shape;
		this.model.applyEdit(this.model.value.shapes.map(visit), undefined, undefined, undoGroup);
	}
	public replace(id: string, start: number, end: number, text: string, style?: ArtifactCanvasTextStyle, undoGroup?: object, runs?: readonly ArtifactCanvasTextRun[]): void {
		this.edit(id, shape => replaceArtifactCanvasText(shape, start, end, text, style, runs), undoGroup);
	}
	public toggle(id: string, start: number, end: number, format: 'bold' | 'italic' | 'underline'): void {
		this.edit(id, shape => {
			const runs = artifactCanvasTextSegments(shape, start, end);
			const enabled = runs.every(run => {
				const style = { ...shape, ...run.style };
				return format === 'bold' ? (style.fontWeight ?? 400) >= 600 : format === 'italic' ? style.fontStyle === 'italic' : style.textDecoration?.includes('underline');
			});
			let result = shape;
			for (const run of runs) {
				const style = { ...shape, ...run.style };
				const strike = style.textDecoration?.includes('line-through');
				const patch: ArtifactCanvasTextStyle = format === 'bold' ? { fontWeight: enabled ? 400 : 700 } : format === 'italic' ? { fontStyle: enabled ? 'normal' : 'italic' } : { textDecoration: enabled ? strike ? 'line-through' : 'none' : strike ? 'underline line-through' : 'underline' };
				result = formatArtifactCanvasText(result, run.start, run.end, patch);
			}
			return result;
		});
	}

	public format(id: string, start: number, end: number, style: ArtifactCanvasTextStyle, styleId?: string): void {
		this.edit(id, shape => formatArtifactCanvasText(shape, start, end, style, styleId));
	}
}
