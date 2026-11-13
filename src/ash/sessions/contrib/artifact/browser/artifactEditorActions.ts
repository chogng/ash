import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { DesignMode, DesignTool } from '../common/config/designEditorConfiguration.js';
import type { ArtifactToolbarAction } from './widget/artifactToolbar.js';

export const artifactToolActions = [
	[DesignTool.Select, () => localize2('sessions.design.selectTool', 'Select (V)'), Lxicon.cursor2],
	[DesignTool.Hand, () => localize2('sessions.design.handTool', 'Move canvas (H)'), Lxicon.hand],
	[DesignTool.Rectangle, () => localize2('sessions.design.rectangle', 'Rectangle'), Lxicon.square],
	[DesignTool.Ellipse, () => localize2('sessions.design.ellipse', 'Ellipse'), Lxicon.circleLarge],
	[DesignTool.Pen, () => localize2('sessions.design.penTool', 'Pen (P)'), Lxicon.pen],
	[DesignTool.Text, () => localize2('sessions.design.textTool', 'Text (T)'), Lxicon.text2],
] as const;

export const artifactModeActions = [
	[DesignMode.Draw, () => localize2('sessions.design.drawMode', 'Draw'), Lxicon.pen],
	[DesignMode.Design, () => localize2('sessions.design.designMode', 'Design'), Lxicon.design],
	[DesignMode.Motion, () => localize2('sessions.design.motionMode', 'Motion'), Lxicon.motion],
	[DesignMode.Code, () => localize2('sessions.design.codeMode', 'Code'), Lxicon.code],
] as const;

export const artifactDocumentActions = [
	['addFrame', () => localize2('sessions.design.addFrame', 'Add frame (F)'), Lxicon.square],
	['importImage', () => localize2('sessions.design.importImage', 'Import image'), Lxicon.add],
] as const;

type ArtifactDocumentAction = typeof artifactDocumentActions[number][0];

/** Projects editor state into actions and remembers the primary choice in each tool group. */
export class ArtifactEditorActions {
	private pointerTool = DesignTool.Select;
	private shapeTool = DesignTool.Rectangle;
	private renderedState: { readonly tool: DesignTool; readonly mode: DesignMode; readonly isBusy: boolean; } | undefined;

	constructor(
		private readonly selectTool: (tool: DesignTool) => unknown,
		private readonly selectMode: (mode: DesignMode) => unknown,
		private readonly runDocumentAction: (action: ArtifactDocumentAction) => unknown,
	) { }

	update(tool: DesignTool, mode: DesignMode, isBusy: boolean): { readonly tools: readonly ArtifactToolbarAction[]; readonly modes: readonly IAction[]; } | undefined {
		if (this.renderedState?.tool === tool && this.renderedState.mode === mode && this.renderedState.isBusy === isBusy) return undefined;
		this.renderedState = { tool, mode, isBusy };
		if (tool === DesignTool.Select || tool === DesignTool.Hand) this.pointerTool = tool;
		if (tool === DesignTool.Rectangle || tool === DesignTool.Ellipse) this.shapeTool = tool;

		const canEdit = !isBusy && mode !== DesignMode.Code;
		const tools = new Map<DesignTool, IAction>(artifactToolActions.map(([id, title, icon]) => {
			const label = title().value;
			return [id, { id: `sessions.design.tool.${id}`, label, tooltip: label, icon, checked: id === tool, enabled: canEdit, run: () => this.selectTool(id) }];
		}));
		const documentActions = artifactDocumentActions.map(([id, title, icon]) => {
			const label = title().value;
			return { id: `sessions.design.${id}`, label, tooltip: label, icon, enabled: canEdit && mode !== DesignMode.Motion, run: () => this.runDocumentAction(id) };
		});
		return {
			tools: [
				{
					...tools.get(this.pointerTool)!,
					id: 'sessions.design.tool.pointer',
					dropdown: { label: localize2('sessions.design.pointerTools', 'Selection tools').value, actions: [tools.get(DesignTool.Select)!, tools.get(DesignTool.Hand)!] },
				},
				{
					...tools.get(this.shapeTool)!,
					id: 'sessions.design.tool.shape',
					dropdown: { label: localize2('sessions.design.shapeTools', 'Shape tools').value, actions: [tools.get(DesignTool.Rectangle)!, tools.get(DesignTool.Ellipse)!] },
				},
				tools.get(DesignTool.Pen)!,
				tools.get(DesignTool.Text)!,
				...documentActions,
			],
			modes: artifactModeActions.map(([id, title, icon]) => {
				const label = title().value;
				return { id: `sessions.design.mode.${id}`, label, tooltip: label, icon, checked: id === mode, enabled: true, run: () => this.selectMode(id) };
			}),
		};
	}
}
