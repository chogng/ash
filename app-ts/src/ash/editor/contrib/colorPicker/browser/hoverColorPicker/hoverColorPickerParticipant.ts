import type { ICodeEditor } from '../../../../browser/editorBrowser.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import type { ColorData } from '../../common/languageColors.js';
import type { HoverAnchor, IEditorHoverParticipant, IEditorHoverRenderContext, IHoverPart, IRenderedHoverParts } from '../../../hover/browser/hoverTypes.js';
import { ColorPickerController } from '../colorPickerController.js';

class ColorHover implements IHoverPart {
	public readonly range;
	constructor(public readonly owner: HoverColorPickerParticipant, public readonly data: ColorData) {
		this.range = data.information.range;
	}
}

export class HoverColorPickerParticipant implements IEditorHoverParticipant {
	constructor(private readonly editor: ICodeEditor) { }

	public computeSync(anchor: HoverAnchor): IHoverPart[] {
		const controller = this.editor.getContribution<ColorPickerController>('editor.contrib.colorPicker');
		if (!controller || controller.isStandaloneVisible) { return []; }
		const activation = this.editor.getOption(EditorOption.colorDecoratorsActivatedOn);
		if (anchor.source === 'mouse' && (activation === 'click' || !anchor.target?.closest('.colorpicker-color-decoration'))) { return []; }
		if (anchor.source === 'click' && activation === 'hover') { return []; }
		const data = controller.getColorData(anchor.position);
		return data ? [new ColorHover(this, data)] : [];
	}

	public renderHoverParts(context: IEditorHoverRenderContext, parts: IHoverPart[]): IRenderedHoverParts {
		const color = parts[0] as ColorHover;
		return this.editor.getContribution<ColorPickerController>('editor.contrib.colorPicker')!.renderHover(context, color.data);
	}
}
