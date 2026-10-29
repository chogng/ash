import { flattenDesignShapes, type DesignShape } from '../model/document.js';
import type { DesignModel } from '../model/designModel.js';
import { designTextSegments, formatDesignText, replaceDesignText, type DesignTextRun, type DesignTextShape, type DesignTextStyle } from '../model/designText.js';

/** Content and character formatting enter the same model transaction as all other edits. */
export class TextCommands {
	constructor(private readonly model: DesignModel) {}
	public get(id: string): DesignTextShape | undefined {
		const shape = flattenDesignShapes(this.model.value.shapes).find(shape => shape.id === id);
		return shape?.kind === 'text' ? shape : undefined;
	}
	private edit(id: string, update: (shape: DesignTextShape) => DesignTextShape, undoGroup?: object): void {
		const visit = (shape: DesignShape): DesignShape =>
			shape.id === id && shape.kind === 'text' ? update(shape) : shape.kind === 'frame' || shape.kind === 'group' ? { ...shape, children: shape.children.map(visit) } : shape;
		this.model.applyEdit(this.model.value.shapes.map(visit), undefined, undefined, undoGroup);
	}
	public replace(id: string, start: number, end: number, text: string, style?: DesignTextStyle, undoGroup?: object, runs?: readonly DesignTextRun[]): void {
		this.edit(id, shape => replaceDesignText(shape, start, end, text, style, runs), undoGroup);
	}
	public toggle(id: string, start: number, end: number, format: 'bold' | 'italic' | 'underline'): void {
		this.edit(id, shape => {
			const runs = designTextSegments(shape, start, end);
			const enabled = runs.every(run => {
				const style = { ...shape, ...run.style };
				return format === 'bold' ? (style.fontWeight ?? 400) >= 600 : format === 'italic' ? style.fontStyle === 'italic' : style.textDecoration?.includes('underline');
			});
			let result = shape;
			for (const run of runs) {
				const style = { ...shape, ...run.style };
				const strike = style.textDecoration?.includes('line-through');
				const patch: DesignTextStyle =
					format === 'bold'
						? { fontWeight: enabled ? 400 : 700 }
						: format === 'italic'
							? { fontStyle: enabled ? 'normal' : 'italic' }
							: {
									textDecoration: enabled ? (strike ? 'line-through' : 'none') : strike ? 'underline line-through' : 'underline',
								};
				result = formatDesignText(result, run.start, run.end, patch);
			}
			return result;
		});
	}

	public format(id: string, start: number, end: number, style: DesignTextStyle, styleId?: string): void {
		this.edit(id, shape => formatDesignText(shape, start, end, style, styleId));
	}
}
