import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { ArtifactCanvasMode, ArtifactCanvasTool } from '../common/config/artifactCanvasEditorConfiguration.js';
import type { ArtifactToolbarAction } from './widget/artifactToolbar.js';

export const artifactToolActions = [
	[ArtifactCanvasTool.Select, () => localize2('sessions.design.selectTool', 'Select (V)'), Lxicon.cursor2],
	[ArtifactCanvasTool.Hand, () => localize2('sessions.design.handTool', 'Move canvas (H)'), Lxicon.hand],
	[ArtifactCanvasTool.Rectangle, () => localize2('sessions.design.rectangle', 'Rectangle'), Lxicon.square],
	[ArtifactCanvasTool.Ellipse, () => localize2('sessions.design.ellipse', 'Ellipse'), Lxicon.circleLarge],
	[ArtifactCanvasTool.Pen, () => localize2('sessions.design.penTool', 'Pen (P)'), Lxicon.pen],
	[ArtifactCanvasTool.Text, () => localize2('sessions.design.textTool', 'Text (T)'), Lxicon.text2],
] as const;

export const artifactModeActions = [
	[ArtifactCanvasMode.Draw, () => localize2('sessions.design.drawMode', 'Draw'), Lxicon.pen],
	[ArtifactCanvasMode.Design, () => localize2('sessions.design.designMode', 'Design'), Lxicon.design],
	[ArtifactCanvasMode.Motion, () => localize2('sessions.design.motionMode', 'Motion'), Lxicon.motion],
	[ArtifactCanvasMode.Code, () => localize2('sessions.design.codeMode', 'Code'), Lxicon.code],
] as const;

export const artifactDocumentActions = [
	['addFrame', () => localize2('sessions.design.addFrame', 'Add frame (F)'), Lxicon.square],
	['importImage', () => localize2('sessions.design.importImage', 'Import image'), Lxicon.add],
] as const;

type ArtifactDocumentAction = typeof artifactDocumentActions[number][0];

/** Projects editor state into actions and remembers the primary choice in each tool group. */
export class ArtifactEditorActions {
	private pointerTool = ArtifactCanvasTool.Select;
	private shapeTool = ArtifactCanvasTool.Rectangle;
	private renderedState: { readonly tool: ArtifactCanvasTool; readonly mode: ArtifactCanvasMode; readonly isBusy: boolean; } | undefined;

	constructor(
		private readonly selectTool: (tool: ArtifactCanvasTool) => unknown,
		private readonly selectMode: (mode: ArtifactCanvasMode) => unknown,
		private readonly runDocumentAction: (action: ArtifactDocumentAction) => unknown,
	) { }

	update(tool: ArtifactCanvasTool, mode: ArtifactCanvasMode, isBusy: boolean): { readonly tools: readonly ArtifactToolbarAction[]; readonly modes: readonly IAction[]; } | undefined {
		if (this.renderedState?.tool === tool && this.renderedState.mode === mode && this.renderedState.isBusy === isBusy) return undefined;
		this.renderedState = { tool, mode, isBusy };
		if (tool === ArtifactCanvasTool.Select || tool === ArtifactCanvasTool.Hand) this.pointerTool = tool;
		if (tool === ArtifactCanvasTool.Rectangle || tool === ArtifactCanvasTool.Ellipse) this.shapeTool = tool;

		const canEdit = !isBusy && mode !== ArtifactCanvasMode.Code;
		const tools = new Map<ArtifactCanvasTool, IAction>(artifactToolActions.map(([id, title, icon]) => {
			const label = title().value;
			return [id, { id: `sessions.design.tool.${id}`, label, tooltip: label, icon, checked: id === tool, enabled: canEdit, run: () => this.selectTool(id) }];
		}));
		const documentActions = artifactDocumentActions.map(([id, title, icon]) => {
			const label = title().value;
			return { id: `sessions.design.${id}`, label, tooltip: label, icon, enabled: canEdit && mode !== ArtifactCanvasMode.Motion, run: () => this.runDocumentAction(id) };
		});
		return {
			tools: [
				{
					...tools.get(this.pointerTool)!,
					id: 'sessions.design.tool.pointer',
					dropdown: { label: localize2('sessions.design.pointerTools', 'Selection tools').value, actions: [tools.get(ArtifactCanvasTool.Select)!, tools.get(ArtifactCanvasTool.Hand)!] },
				},
				{
					...tools.get(this.shapeTool)!,
					id: 'sessions.design.tool.shape',
					dropdown: { label: localize2('sessions.design.shapeTools', 'Shape tools').value, actions: [tools.get(ArtifactCanvasTool.Rectangle)!, tools.get(ArtifactCanvasTool.Ellipse)!] },
				},
				tools.get(ArtifactCanvasTool.Pen)!,
				tools.get(ArtifactCanvasTool.Text)!,
				...documentActions,
			],
			modes: artifactModeActions.map(([id, title, icon]) => {
				const label = title().value;
				return { id: `sessions.design.mode.${id}`, label, tooltip: label, icon, checked: id === mode, enabled: true, run: () => this.selectMode(id) };
			}),
		};
	}
}
