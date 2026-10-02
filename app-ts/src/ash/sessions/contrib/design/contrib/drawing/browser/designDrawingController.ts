import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import type { DesignPoint } from '../../../common/core/geometry.js';
import type { DesignPathNode, DesignShape } from '../../../common/model/document.js';
import type { DocumentCommands } from '../../../common/commands/documentCommands.js';
import type { DesignDrawingParticipant } from '../../../browser/designEditorBrowser.js';
import { DesignMode, DesignTool } from '../../../common/config/editorConfiguration.js';

interface DrawingHost {
	getTool(): DesignTool;
	getMode(): DesignMode;
	selectShape(id: string): void;
}

/** Drafts stay outside history; completing a shape or stroke commits exactly one edit. */
export class DesignDrawingController extends Disposable implements DesignDrawingParticipant {
	private readonly changeEmitter = this._register(new Emitter<void>());
	public readonly onDidChange = this.changeEmitter.event;
	private start: DesignPoint | undefined;
	private nodes: { x: number; y: number; incoming: DesignPoint; outgoing: DesignPoint }[] = [];
	private draft: DesignShape | undefined;
	private isPen = false;
	private isFreehand = false;

	constructor(private readonly host: DrawingHost, private readonly commands: DocumentCommands) {
		super();
	}

	public get preview(): DesignShape | undefined { return this.draft; }

	public cancel(): void {
		const hadDraft = !!this.draft;
		this.start = undefined;
		this.draft = undefined;
		this.nodes = [];
		this.isPen = this.isFreehand = false;
		if (hadDraft && !this.isDisposed) { this.changeEmitter.fire(); }
	}

	public begin(point: DesignPoint): boolean {
		const tool = this.host.getTool();
		if (this.host.getMode() === DesignMode.Code || this.host.getMode() === DesignMode.Motion || [DesignTool.Select, DesignTool.Hand].includes(tool)) { return false; }
		if (tool === DesignTool.Text) {
			const id = this.commands.addShape('text', { x: point.x + 120, y: point.y + 40 }, localize('sessions.design.text', 'Text'));
			this.host.selectShape(id);
			return true;
		}
		this.start = point;
		this.isPen = tool === DesignTool.Pen && this.host.getMode() === DesignMode.Design;
		this.isFreehand = tool === DesignTool.Pen && this.host.getMode() === DesignMode.Draw;
		if (tool === DesignTool.Pen) {
			this.nodes.push({ ...point, incoming: point, outgoing: point });
			this.updatePath();
		} else {
			this.draft = { id: generateUuid(), kind: tool === DesignTool.Rectangle ? 'rectangle' : 'ellipse', ...point, width: 1, height: 1, rotation: 0, fill: '#808080' };
		}
		this.changeEmitter.fire();
		return true;
	}

	public update(point: DesignPoint): void {
		if (this.isFreehand) {
			const last = this.nodes.at(-1)!;
			if (Math.hypot(point.x - last.x, point.y - last.y) < 2) { return; }
			this.nodes.push({ ...point, incoming: point, outgoing: point });
			this.updatePath();
		} else if (this.isPen) {
			const node = this.nodes.at(-1)!;
			node.outgoing = point;
			node.incoming = { x: 2 * node.x - point.x, y: 2 * node.y - point.y };
			this.updatePath();
		} else if (this.draft && this.start) {
			this.draft = { ...this.draft, x: Math.min(this.start.x, point.x), y: Math.min(this.start.y, point.y), width: Math.max(1, Math.abs(point.x - this.start.x)), height: Math.max(1, Math.abs(point.y - this.start.y)) };
		}
		this.changeEmitter.fire();
	}

	public end(): void { if (!this.isPen) { this.finish(); } }

	public complete(): boolean {
		if (!this.isPen) { return false; }
		this.finish();
		return true;
	}

	private updatePath(): void {
		// Include controls in the local frame so the file's normalized handle contract holds.
		const points = this.nodes.flatMap(node => [node, node.incoming, node.outgoing]);
		const x = Math.min(...points.map(point => point.x));
		const y = Math.min(...points.map(point => point.y));
		const width = Math.max(1, Math.max(...points.map(point => point.x)) - x);
		const height = Math.max(1, Math.max(...points.map(point => point.y)) - y);
		const normalize = (point: DesignPoint): DesignPoint => ({ x: (point.x - x) / width, y: (point.y - y) / height });
		const nodes: DesignPathNode[] = this.nodes.map(node => ({ ...normalize(node), incoming: normalize(node.incoming), outgoing: normalize(node.outgoing) }));
		if (nodes.length === 1) { nodes.push(nodes[0]); }
		this.draft = { id: this.draft?.id ?? generateUuid(), kind: 'path', x, y, width, height, rotation: 0, fill: '#808080', strokeWidth: 2, closed: false, nodes };
	}

	private finish(): void {
		const shape = this.draft;
		const canCommit = shape && (shape.kind !== 'path' || this.nodes.length >= 2);
		this.cancel();
		if (canCommit) { this.commands.insertShape(shape); this.host.selectShape(shape.id); }
	}
}
