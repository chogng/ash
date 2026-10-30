import { validateSerializedGridViewDescriptor } from '../../base/browser/ui/grid/gridviewDescriptor.js';
import { h } from '../../base/browser/dom.js';
import type { Direction, ISerializableView, SerializedGridDescriptor } from '../../base/browser/ui/grid/grid.js';
import type { Event } from '../../base/common/event.js';
import { localize } from '../../nls.js';

export type CodeCardId = 'panel' | 'auxiliarybar' | 'info';
export type CodeCardTarget = CodeCardId | 'sessions' | 'editor';

/** Window-local presentation of retained content. The desktop Grid owns topology and geometry. */
export interface ICodeCardLayout {
	readonly active: boolean;
	readonly onDidChangeCards: Event<void>;
	readonly information: CodeInformationView;
	readonly expandedCard: CodeCardId | undefined;
	isCardVisible(id: CodeCardId): boolean;
	setInformation(element: HTMLElement | undefined): void;
	toggleInformation(): void;
	closeCard(id: CodeCardId): void;
	resizeCard(id: CodeCardId, widthDelta: number, heightDelta: number): void;
	moveCard(id: CodeCardId, target: CodeCardTarget, direction: Direction): void;
	expandCard(id: CodeCardId): void;
	detachCard(id: CodeCardId, detached: boolean): void;
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
		const tree: unknown = JSON.parse(value);
		const ids = new Set<string>();
		let nodes = 0;
		const visit = (node: unknown): boolean => {
			if (++nodes > 40 || !node || typeof node !== 'object') return false;
			const item = node as Record<string, unknown>;
			if (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size < 0 || item.size > 100000)
				return false;
			if (item.priority !== 'high' && item.priority !== 'normal') return false;
			if (item.type === 'branch')
				return (
					(item.orientation === 'vertical' || item.orientation === 'horizontal') &&
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
		validateSerializedGridViewDescriptor(tree as SerializedGridDescriptor);
		return tree as SerializedGridDescriptor;
	} catch {
		return undefined;
	}
}
