import { Lxicon } from '../../../../base/common/lxicons.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { RawContextKey, type IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ArtifactWorkspace, registerArtifactWorkspaceMode } from '../../artifact/browser/artifactWorkspace.js';
import { ArtifactWorkspaceId, getArtifactWorkspaceTitle } from '../../artifact/common/artifactWorkspace.js';
import { DesignMode } from '../../artifact/common/config/designEditorConfiguration.js';
import { getDesignShapeEntries } from '../../artifact/common/model/hitTest.js';

const CanConnectSelection = new RawContextKey<boolean>('sessions.artifacts.whiteboard.canConnectSelection', false);

class WhiteboardWorkspace extends ArtifactWorkspace {
	public static registerToolbarActions(): void {
		this.registerWorkspaceActions(ArtifactWorkspaceId.Whiteboard, [
			{ id: 'note', title: localize2('sessions.creator.whiteboard.addNote', 'Add note'), run: workspace => workspace.addNote() },
			{ id: 'connect', title: localize2('sessions.creator.whiteboard.connect', 'Connect selection'), precondition: CanConnectSelection.isEqualTo(true), run: workspace => workspace.connect() },
		]);
	}
	protected override createModeContent(): void { this.editor.setMode(DesignMode.Draw); }
	private addNote(): void {
		const index = this.document.model.value.shapes.filter(shape => shape.kind === 'group').length;
		const note = {
			id: generateUuid(), kind: 'group' as const, x: 40 + index % 4 * 220, y: 40 + Math.floor(index / 4) * 220, width: 200, height: 200, contentWidth: 200, contentHeight: 200, rotation: 0, fill: '#fff0a6', children: [
				{ id: generateUuid(), kind: 'rectangle' as const, x: 0, y: 0, width: 200, height: 200, rotation: 0, fill: '#fff0a6' },
				{ id: generateUuid(), kind: 'text' as const, x: 16, y: 16, width: 168, height: 168, rotation: 0, fill: '#242424', text: localize('sessions.creator.whiteboard.noteText', 'Your idea'), fontSize: 20 },
			]
		};
		this.commands.insertShape(note);
		this.editor.revealShape(note.children[1].id);
	}
	private connect(): void {
		const selected = getDesignShapeEntries(this.document.model.value.shapes).filter(entry => this.editor.selection.ids.has(entry.shape.id));
		if (selected.length !== 2) { return; }
		const points = selected.map(entry => ({ x: entry.world.x + entry.world.width / 2, y: entry.world.y + entry.world.height / 2 }));
		const x = Math.min(points[0].x, points[1].x);
		const y = Math.min(points[0].y, points[1].y);
		const width = Math.max(1, Math.abs(points[1].x - points[0].x));
		const height = Math.max(1, Math.abs(points[1].y - points[0].y));
		const nodes = points.map(point => { const anchor = { x: (point.x - x) / width, y: (point.y - y) / height }; return { ...anchor, incoming: anchor, outgoing: anchor }; });
		this.commands.insertShape({ id: generateUuid(), kind: 'path', x, y, width, height, rotation: 0, fill: '#808080', closed: false, strokeWidth: 2, nodes });
	}
	protected override bindToolbarContext(contextKeys: IContextKeyService): () => void {
		const canConnect = CanConnectSelection.bindTo(contextKeys);
		return () => canConnect.set(this.editor.selection.ids.size === 2);
	}
}

WhiteboardWorkspace.registerToolbarActions();
registerArtifactWorkspaceMode({
	id: ArtifactWorkspaceId.Whiteboard,
	title: getArtifactWorkspaceTitle(ArtifactWorkspaceId.Whiteboard),
	description: localize('sessions.creator.whiteboard.description', 'Sketch ideas, arrange notes and connect your thinking.'),
	icon: Lxicon.pen,
	help: localize('sessions.creator.whiteboard.help', 'Add note creates a movable note. Select its text in Layers to edit the idea in Shape properties. Select two objects and choose Connect selection to draw a line. Draw provides freehand sketching. Lines keep their drawn geometry when objects move.'),
}, (instantiation, ownerDocument) => instantiation.createInstance(WhiteboardWorkspace, ownerDocument, ArtifactWorkspaceId.Whiteboard));
