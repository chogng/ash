import { LayoutPriority } from '../../base/browser/ui/splitview/splitview.js';
import { Orientation } from '../../base/browser/ui/sash/sash.js';
import { validateSerializedGridViewDescriptor } from '../../base/browser/ui/grid/gridview.js';
import { h, type IDimension } from '../../base/browser/dom.js';
import { type Direction, type ISerializableView, type SerializedGridDescriptor } from '../../base/browser/ui/grid/grid.js';
import { Emitter, Event } from '../../base/common/event.js';
import { type IDisposable } from '../../base/common/lifecycle.js';
import { AGENTS_FLOATING_PANEL_GAP } from '../common/sizes.js';
import { localize } from '../../nls.js';
import type { MenuId } from '../../platform/actions/common/actions.js';
import type { DockedAuxiliaryBarController } from './dockedAuxiliaryBarController.js';
import type { EditorPart } from '../../workbench/browser/parts/editor/editorPart.js';

export type CodeCardId = 'terminal' | 'files' | 'changes' | 'info';
export type CodeCardTarget = CodeCardId | 'sessions';

/** Card chrome consumes a retained content host, independently of the Workbench Part that supplies it. */
export interface ICodeCardPresentation {
	readonly title: string;
	readonly domNode: HTMLElement;
	readonly header: HTMLElement | undefined;
	readonly layoutMenuId?: MenuId;
	layout(dimension: IDimension): void;
}

/** Window-local presentation of retained content. The desktop Grid owns topology and geometry. */
export interface ICodeCardLayout {
	readonly active: boolean;
	readonly onDidChangeCards: Event<void>;
	readonly information: CodeInformationView;
	readonly files: DockedAuxiliaryBarController;
	readonly changes: CodeChangesView;
	setChangesPart(part: EditorPart): void;
	setChangesVisible(visible: boolean): void;
	readonly expandedCard: CodeCardId | undefined;
	isCardVisible(id: CodeCardId): boolean;
	setInformation(element: HTMLElement | undefined): void;
	toggleInformation(): void;
	closeCard(id: CodeCardId): void;
	moveCard(id: CodeCardId, target: CodeCardTarget, direction: Direction): void;
	expandCard(id: CodeCardId): void;
	detachCard(id: CodeCardId, detached: boolean): void;
}

const filesCardHeaderHeight = 36;
const filesCardBorderSize = 2;
const filesCardFrameSize = 2 * AGENTS_FLOATING_PANEL_GAP;

/** Hosts the retained Changes editor independently of the Files document groups. */
export class CodeChangesView implements ISerializableView {
	public readonly element: HTMLElement;
	public readonly card: HTMLElement;
	public readonly header: HTMLElement;
	public readonly minimumWidth = 360;
	public readonly minimumHeight = 240;
	public readonly maximumWidth = Infinity;
	public readonly maximumHeight = Infinity;
	private readonly body: HTMLElement;
	private part: EditorPart | undefined;

	constructor(document: Document) {
		this.element = h(document, 'div', { className: 'ash-workbench-part-frame ash-code-changes-frame' });
		this.card = h(document, 'section', { className: 'ash-code-changes-card ash-sessions-tool-card' });
		this.card.setAttribute('role', 'region');
		const title = localize('sessions.changes.title', 'Changes');
		this.card.setAttribute('aria-label', title);
		this.header = h(document, 'header', { className: 'ash-code-card-header' });
		const label = h(document, 'span', { className: 'ash-code-card-title' });
		label.textContent = title;
		this.header.append(label);
		this.body = h(document, 'div', { className: 'ash-code-changes-body' });
		this.card.append(this.header, this.body);
		this.element.append(this.card);
	}

	public mount(part: EditorPart): void {
		this.part = part;
		this.body.append(part.domNode);
	}

	public setVisible(visible: boolean): void {
		this.part?.setVisible(visible);
		this.part?.setEditorContentVisible(visible);
	}

	public layout(dimension: IDimension): void {
		this.layoutCard({ width: dimension.width - filesCardFrameSize, height: dimension.height - filesCardFrameSize });
	}

	public layoutCard(dimension: IDimension): void {
		this.part?.layout({
			width: Math.max(0, dimension.width - filesCardBorderSize),
			height: Math.max(0, dimension.height - filesCardBorderSize - filesCardHeaderHeight),
		});
	}

	public toJSON(): string { return 'changes'; }
}

/** A Grid leaf, not a second session model or a shared Workbench Part. */
export class CodeInformationView implements ISerializableView {
	readonly element: HTMLElement;
	readonly card: HTMLElement;
	readonly header: HTMLElement;
	readonly body: HTMLElement;
	readonly minimumWidth = 236;
	readonly minimumHeight = 140;
	readonly maximumWidth = Infinity;
	readonly maximumHeight = Infinity;
	constructor(document: Document) {
		this.element = h(document, 'div', { className: 'ash-workbench-part-frame' });
		this.element.style.padding = '4px';
		this.card = h(document, 'section', { className: 'ash-code-information-card ash-sessions-tool-card' });
		this.card.dataset.codeCard = 'info';
		this.header = h(document, 'header', { className: 'ash-code-card-header' });
		const title = h(document, 'span', { className: 'ash-code-card-title' });
		title.textContent = localize('sessions.cards.information', 'Session information');
		this.card.setAttribute('aria-label', title.textContent);
		this.header.append(title);
		this.body = h(document, 'div', { className: 'ash-code-information-body' });
		this.card.append(this.header, this.body);
		this.element.append(this.card);
	}
	layout(): void { }
	toJSON(): string {
		return 'info';
	}
}

/** Validate the persisted tree once, at the storage boundary, before attaching retained views. */
export function readCodeCardLayout(
	value: string | undefined,
	partIds: readonly string[],
): SerializedGridDescriptor | undefined {
	if (!value) return undefined;
	try {
		const tree = validateSerializedGridViewDescriptor(JSON.parse(value));
		const ids = new Set<string>();
		let nodes = 0;
		const visit = (node: unknown): boolean => {
			if (++nodes > 40 || !node || typeof node !== 'object') return false;
			const item = node as Record<string, unknown>;
			if (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size < 0 || item.size > 100000)
				return false;
			if (item.priority !== LayoutPriority.High && item.priority !== LayoutPriority.Normal) return false;
			if (item.type === 'branch')
				return (
					(item.orientation === Orientation.VERTICAL || item.orientation === Orientation.HORIZONTAL) &&
					Array.isArray(item.children) &&
					item.children.length > 0 &&
					item.children.every(visit)
				);
			if (
				item.type !== 'leaf' ||
				typeof item.data !== 'string' ||
				typeof item.visible !== 'boolean' ||
				ids.has(item.data) ||
				!partIds.includes(item.data)
			)
				return false;
			ids.add(item.data);
			return true;
		};
		if (!visit(tree) || ids.size !== partIds.length) return undefined;
		return tree;
	} catch {
		return undefined;
	}
}
