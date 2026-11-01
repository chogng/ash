import { h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { ScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import type { AgentTraceGraph } from '../../common/chatDebugEvents.js';
import { relationLabel, type AgentTraceViewModel } from './agentTraceModel.js';
import type { ChatDebugFilterState } from './chatDebugFilters.js';

/** Geometry is a projection of saved edges. It never infers causal links from time or row order. */
export class ChatDebugFlowChartView extends Disposable {
	readonly container: HTMLElement;
	private readonly selectEvent = this._register(new Emitter<string>());
	readonly onDidSelectEvent = this.selectEvent.event;
	private readonly nodes = this._register(new DisposableStore());
	private readonly canvas: HTMLElement;
	private readonly notice: HTMLElement;
	private readonly scroll: ScrollableElement;
	private readonly search: InputBox;
	private graph: AgentTraceGraph | undefined;
	private model: AgentTraceViewModel | undefined;
	private limit = 100;
	private scale = 1;
	private readonly more: Button;

	constructor(parent: HTMLElement, private readonly filters: ChatDebugFilterState) {
		super();
		const document = parent.ownerDocument;
		this.container = h(document, 'section', { className: 'ash-chat-debug-flow' });
		this.container.hidden = true;
		this.container.setAttribute('aria-label', localize('chatDebug.flowChart', 'Flow Chart'));
		const controls = h(document, 'div', { className: 'ash-chat-debug-view-navigation' });
		this.search = this._register(new InputBox(controls, {
			inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: localize('chatDebug.filterFlow', 'Filter Flow Chart'),
			placeholder: localize('chatDebug.filterFlow', 'Filter Flow Chart'),
		}));
		this._register(this.search.onDidChange(() => filters.setTextFilter(this.search.value)));
		for (const [delta, label] of [[0.25, localize('chatDebug.zoomIn', 'Zoom In')], [-0.25, localize('chatDebug.zoomOut', 'Zoom Out')], [0, localize('chatDebug.resetZoom', 'Reset Zoom')]] as const) {
			this._register(new Button(controls, {
				...defaultButtonStyles, presentation: 'secondary', label,
				onClick: () => {
					this.scale = delta ? Math.max(0.5, Math.min(2, this.scale + delta)) : 1;
					this.render();
				},
			}));
		}
		this.notice = h(document, 'p', { className: 'ash-chat-debug-notice' });
		this.notice.setAttribute('aria-live', 'polite');
		this.canvas = h(document, 'div', { className: 'ash-chat-debug-flow-canvas' });
		this.scroll = this._register(new ScrollableElement(this.container, { direction: 'both', tabIndex: 0, ariaLabel: localize('chatDebug.graphCanvas', 'Execution Graph Canvas') }));
		this.scroll.setContent(this.canvas);
		this.scroll.element.classList.add('ash-chat-debug-flow-host');
		this.more = this._register(new Button(this.container, {
			...defaultButtonStyles, presentation: 'secondary', label: localize('chatDebug.moreNodes', 'Show More Nodes'),
			onClick: () => { this.limit += 100; this.render(); },
		}));
		this.container.prepend(controls, this.notice, this.scroll.element);
		parent.append(this.container);
		this._register(toDisposable(() => this.container.remove()));
	}

	show(graph: AgentTraceGraph | undefined, model: AgentTraceViewModel): void {
		this.graph = graph;
		this.model = model;
		this.container.hidden = false;
		this.search.value = this.filters.textFilter;
		this.search.showValidation(this.filters.error ?? '');
		this.render();
	}

	hide(): void { this.container.hidden = true; }
	clear(): void {
		this.hide();
		this.graph = undefined;
		this.model = undefined;
		this.limit = 100;
		this.scale = 1;
		this.nodes.clear();
		this.canvas.replaceChildren();
	}
	layout(): void { this.scroll.layout(); }
	focus(): void { this.search.focus(); }
	getAccessibleContent(): string {
		if (!this.graph || !this.model) { return this.notice.textContent ?? ''; }
		const nodes = Object.values(this.graph.nodes).filter(node => !this.filters.active || this.model!.matched.has(this.model!.graphTarget(node)?.id ?? ''));
		const labels = nodes.map(node => `${node.id}: ${node.label}`);
		const included = new Set(nodes.map(node => node.id));
		return [this.notice.textContent, ...labels, ...this.graph.edges.filter(edge => included.has(edge.from) && included.has(edge.to)).map(edge => `${edge.from} → ${edge.to}: ${relationLabel(edge.kind)}`)].join('\n');
	}

	private render(): void {
		const focused = this.canvas.ownerDocument.activeElement?.getAttribute('data-graph-node');
		this.nodes.clear(); this.canvas.replaceChildren();
		const all = Object.values(this.graph?.nodes ?? {}).filter(node => !this.filters.active || this.model?.matched.has(this.model.graphTarget(node)?.id ?? ''));
		const visible = all.slice(0, this.limit);
		this.more.domNode.hidden = visible.length === all.length;
		this.notice.textContent = this.graph ? [
			localize('chatDebug.graphScope', '{0} of {1} nodes. Arrows show saved relationships; layout does not establish execution order.', visible.length, all.length),
			...this.graph.warnings,
		].join('\n') : localize('chatDebug.loadingGraph', 'Loading saved execution relationships…');
		const lanes = new Map<string, number>();
		const rows = new Map<string, number>();
		const positions = new Map<string, { x: number; y: number; }>();
		const width = 240 * this.scale;
		const height = 44 * this.scale;
		for (const node of visible) {
			if (!lanes.has(node.threadId)) { lanes.set(node.threadId, lanes.size); }
			const row = rows.get(node.threadId) ?? 0;
			rows.set(node.threadId, row + 1);
			positions.set(node.id, { x: lanes.get(node.threadId)! * 280 * this.scale + 20, y: row * 76 * this.scale + 20 });
		}
		const canvasWidth = Math.max(1, lanes.size) * 280 * this.scale + 40;
		const canvasHeight = Math.max(1, ...rows.values()) * 76 * this.scale + 40;
		this.canvas.style.width = `${canvasWidth}px`;
		this.canvas.style.height = `${canvasHeight}px`;
		const svg = this.canvas.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', String(canvasWidth)); svg.setAttribute('height', String(canvasHeight));
		svg.setAttribute('aria-hidden', 'true');
		for (const edge of this.graph?.edges ?? []) {
			const from = positions.get(edge.from); const to = positions.get(edge.to);
			if (!from || !to) { continue; }
			const line = this.canvas.ownerDocument.createElementNS(svg.namespaceURI, 'path');
			const start = { x: from.x + width / 2, y: from.y + height };
			const end = { x: to.x + width / 2, y: to.y };
			line.setAttribute('d', `M ${start.x} ${start.y} L ${end.x} ${end.y} m -4 -6 l 4 6 l 4 -6`);
			line.setAttribute('data-graph-edge', `${edge.from}:${edge.to}`);
			svg.append(line);
			const label = this.canvas.ownerDocument.createElementNS(svg.namespaceURI, 'text');
			label.setAttribute('x', String((start.x + end.x) / 2 + 8));
			label.setAttribute('y', String((start.y + end.y) / 2));
			label.textContent = relationLabel(edge.kind);
			svg.append(label);
		}
		this.canvas.append(svg);
		for (const node of visible) {
			const target = this.model?.graphTarget(node);
			const button = this.nodes.add(new Button(this.canvas, {
				...defaultButtonStyles, presentation: 'secondary', label: node.label,
				onClick: () => { if (target) { this.selectEvent.fire(target.id); } },
			}));
			button.domNode.classList.add('ash-chat-debug-flow-node');
			button.domNode.dataset.graphNode = node.id;
			button.domNode.setAttribute('aria-label', localize('chatDebug.graphNode', '{0} · Thread {1}', node.label, node.threadId));
			button.domNode.setAttribute('aria-disabled', String(!target));
			const position = positions.get(node.id)!;
			Object.assign(button.domNode.style, { left: `${position.x}px`, top: `${position.y}px`, width: `${width}px`, height: `${height}px` });
			if (focused === node.id) { button.focus(); }
		}
		this.scroll.layout();
	}
}
