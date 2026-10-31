import './media/scm.css';
import '../../../../base/browser/markdownRenderer.css';
import { getWindow, h, isHTMLElement, svg as createSvgElement } from '../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { LabelActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import type { IAction } from '../../../../base/common/actions.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { IScopedContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService, type IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import type { IHoverService, IManagedHover } from '../../../../platform/hover/browser/hoverService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { openLinkFromMarkdown } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { localize, getNLSLanguage } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { chartsBlue, chartsPurple } from '../../../../platform/theme/common/colors/chartsColors.js';
import { SCMIncomingHistoryItemId, SCMOutgoingHistoryItemId, type ISCMHistoryItemDetails, type ISCMHistoryItem, type ISCMHistoryItemRef, type ISCMHistoryItemViewModel, type ISCMHistoryItemGraphNode } from '../common/history.js';
import '../../../common/theme.js';

registerColor('scmGraph.historyItemRefColor', {
	dark: chartsBlue, light: chartsBlue, hcDark: chartsBlue, hcLight: chartsBlue,
}, { description: 'History item reference color.', owner: 'workbench.scm' });
registerColor('scmGraph.historyItemRemoteRefColor', {
	dark: chartsPurple, light: chartsPurple, hcDark: chartsPurple, hcLight: chartsPurple,
}, { description: 'History item remote reference color.', owner: 'workbench.scm' });
registerColor('scmGraph.historyItemHoverLabelForeground', {
	dark: 'panel.background', light: 'panel.background', hcDark: 'panel.background', hcLight: 'panel.background',
}, { description: 'History item hover label foreground color.', owner: 'workbench.scm' });

// Branch series have their own palette so the first side lane cannot reuse HEAD's blue.
const GraphColors = [
	registerColor('scmGraph.foreground1', {
		dark: '#FFB000', light: '#FFB000', hcDark: '#FFB000', hcLight: '#FFB000',
	}, { description: 'Source control graph foreground color (1).', owner: 'workbench.scm' }),
	registerColor('scmGraph.foreground2', {
		dark: '#DC267F', light: '#DC267F', hcDark: '#DC267F', hcLight: '#DC267F',
	}, { description: 'Source control graph foreground color (2).', owner: 'workbench.scm' }),
	registerColor('scmGraph.foreground3', {
		dark: '#994F00', light: '#994F00', hcDark: '#994F00', hcLight: '#994F00',
	}, { description: 'Source control graph foreground color (3).', owner: 'workbench.scm' }),
	registerColor('scmGraph.foreground4', {
		dark: '#40B0A6', light: '#40B0A6', hcDark: '#40B0A6', hcLight: '#40B0A6',
	}, { description: 'Source control graph foreground color (4).', owner: 'workbench.scm' }),
	registerColor('scmGraph.foreground5', {
		dark: '#B66DFF', light: '#B66DFF', hcDark: '#B66DFF', hcLight: '#B66DFF',
	}, { description: 'Source control graph foreground color (5).', owner: 'workbench.scm' }),
];

const LaneHeight = 22;
const LaneWidth = 11;
const CurveRadius = 5;
const ColorCount = GraphColors.length;
// Reference colors must not be allocated to unrelated branch lanes.
const HistoryItemRefColor = ColorCount;
const HistoryItemRemoteRefColor = ColorCount + 1;

interface Lane {
	readonly id: string;
	readonly colorIndex: number;
}

interface GraphRow {
	readonly historyItem: ISCMHistoryItem;
	readonly color?: number;
	readonly inputSwimlanes: readonly Lane[];
	readonly outputSwimlanes: readonly Lane[];
}

type GraphNodeKind = 'commit' | 'head' | 'merge' | 'incoming-changes' | 'outgoing-changes';

export const SWIMLANE_HEIGHT = LaneHeight;
export const SWIMLANE_WIDTH = LaneWidth;

/** Projects ordered SCM history into stable, color-carrying swimlanes. */
export function toISCMHistoryItemViewModelArray(historyItems: readonly ISCMHistoryItem[], colorMap = new Map<string, number>(), currentHistoryItemRef?: ISCMHistoryItemRef, comparison?: { readonly remote: ISCMHistoryItemRef; readonly base: string; readonly incoming: boolean; readonly outgoing: boolean; }): ISCMHistoryItemViewModel[] {
	let items = [...historyItems];
	const parentOverrides = new Map<string, readonly string[]>();
	const local = currentHistoryItemRef?.revision;
	const remote = comparison?.remote.revision;
	const base = comparison?.base;
	if (comparison && local && remote && base && local !== remote) {
		if (comparison.incoming && remote !== base) {
			const baseIndex = items.findIndex(item => item.id === base);
			if (baseIndex >= 0 && items.some(item => item.id === remote)) {
				const reachable = new Set<string>();
				const byId = new Map(items.map(item => [item.id, item]));
				const pending = [remote];
				while (pending.length > 0) {
					const id = pending.pop()!;
					if (id === base || reachable.has(id)) { continue; }
					reachable.add(id);
					pending.push(...(byId.get(id)?.parentIds ?? []));
				}
				for (const item of items) {
					if (reachable.has(item.id)) { parentOverrides.set(item.id, item.parentIds.map(id => id === base ? SCMIncomingHistoryItemId : id)); }
				}
				items.splice(baseIndex, 0, { id: SCMIncomingHistoryItemId, subject: localize('scm.history.incoming', 'Incoming Changes'), message: '', parentIds: [base], comparison: { revision: remote, baseRevision: base } });
			}
		}
		if (comparison.outgoing && local !== base) {
			const localIndex = items.findIndex(item => item.id === local);
			if (localIndex >= 0) { items.splice(localIndex, 0, { id: SCMOutgoingHistoryItemId, subject: localize('scm.history.outgoing', 'Outgoing Changes'), message: '', parentIds: [local], comparison: { revision: local, baseRevision: base } }); }
		}
	}
	const rows = createRows(items, colorMap, parentOverrides, currentHistoryItemRef, comparison?.remote);
	return rows.map(row => ({
		historyItem: row.historyItem,
		color: row.color,
		inputSwimlanes: row.inputSwimlanes.map(lane => ({ id: lane.id, color: lane.colorIndex })),
		outputSwimlanes: row.outputSwimlanes.map(lane => ({ id: lane.id, color: lane.colorIndex })),
		kind: row.historyItem.id === SCMIncomingHistoryItemId ? 'incoming-changes' : row.historyItem.id === SCMOutgoingHistoryItemId ? 'outgoing-changes' : row.historyItem.id === currentHistoryItemRef?.revision ? 'HEAD' : 'node',
	}));
}

function createRows(historyItems: readonly ISCMHistoryItem[], colorMap: ReadonlyMap<string, number>, parentOverrides: ReadonlyMap<string, readonly string[]>, currentHistoryItemRef?: ISCMHistoryItemRef, currentHistoryItemRemoteRef?: ISCMHistoryItemRef): GraphRow[] {
	const rows: GraphRow[] = [];
	const historyById = new Map(historyItems.map(item => [item.id, item]));
	let lanes: readonly Lane[] = [];
	let nextColorIndex = 0;
	const referenceColor = (item: ISCMHistoryItem): number | undefined => {
		if (item.id === SCMIncomingHistoryItemId) return HistoryItemRemoteRefColor;
		if (item.id === SCMOutgoingHistoryItemId) return HistoryItemRefColor;
		for (const reference of item.references ?? []) {
			const color = colorMap.get(reference.id) ?? reference.color;
			if (color !== undefined) return color;
		}
		if (item.id === currentHistoryItemRef?.revision || item.references?.some(reference => reference.id === currentHistoryItemRef?.id)) {
			return HistoryItemRefColor;
		}
		if (item.id === currentHistoryItemRemoteRef?.revision || item.references?.some(reference => reference.category === 'remoteBranch')) {
			return HistoryItemRemoteRefColor;
		}
		return undefined;
	};
	const allocateColor = (): number => {
		const colorIndex = nextColorIndex;
		nextColorIndex = (nextColorIndex + 1) % ColorCount;
		return colorIndex;
	};

	for (const historyItem of historyItems) {
		const parentIds = parentOverrides.get(historyItem.id) ?? historyItem.parentIds;
		const inputSwimlanes = lanes.map((lane) => ({ ...lane }));
		const outputSwimlanes: Lane[] = [];
		let firstParentAdded = false;

		for (const lane of inputSwimlanes) {
			if (lane.id === historyItem.id) {
				if (!firstParentAdded && parentIds.length > 0) {
					outputSwimlanes.push({ id: parentIds[0], colorIndex: referenceColor(historyItem) ?? lane.colorIndex });
					firstParentAdded = true;
				}
				continue;
			}
			outputSwimlanes.push({ ...lane });
		}

		for (let index = firstParentAdded ? 1 : 0; index < parentIds.length; index += 1) {
			const parent = historyById.get(parentIds[index]);
			const colorIndex = index === 0 ? referenceColor(historyItem) : parent ? referenceColor(parent) : undefined;
			outputSwimlanes.push({ id: parentIds[index], colorIndex: colorIndex ?? allocateColor() });
		}
		rows.push({ historyItem, color: referenceColor(historyItem), inputSwimlanes, outputSwimlanes });
		lanes = outputSwimlanes;
	}
	return rows;
}

/** Renders one SCM history swimlane row with a stable color for each branch lane. */
export function renderSCMHistoryItemGraph(historyItemViewModel: ISCMHistoryItemViewModel, expandedHeight = LaneHeight, document: Document = globalThis.document): SVGSVGElement {
	const row = historyItemViewModel;
	const kind: GraphNodeKind = row.kind === 'incoming-changes' || row.kind === 'outgoing-changes' ? row.kind : row.kind === 'HEAD' ? 'head' : row.historyItem.parentIds.length > 1 ? 'merge' : 'commit';
	const svg = createSvgElement(document, 'svg');
	svg.classList.add('ash-scm-graph-graph', kind);
	svg.setAttribute('aria-hidden', 'true');
	const inputIndex = row.inputSwimlanes.findIndex((lane) => lane.id === row.historyItem.id);
	const circleIndex = inputIndex === -1 ? row.inputSwimlanes.length : inputIndex;
	const circleColorIndex = row.color ?? (row.historyItem.parentIds.length > 0 ? row.outputSwimlanes[circleIndex]?.color ?? 0 : row.inputSwimlanes[circleIndex]?.color ?? 0);
	let outputSwimlaneIndex = 0;

	for (let index = 0; index < row.inputSwimlanes.length; index += 1) {
		const inputLane = row.inputSwimlanes[index];
		if (inputLane.id === row.historyItem.id) {
			if (index !== circleIndex) {
				appendPath(svg, `M ${LaneWidth * (index + 1)} 0 A ${LaneWidth} ${LaneWidth} 0 0 1 ${LaneWidth * index} ${LaneWidth} H ${LaneWidth * (circleIndex + 1)}`, inputLane.color);
			} else if (row.historyItem.parentIds.length > 0) {
				outputSwimlaneIndex += 1;
			}
			continue;
		}

		if (outputSwimlaneIndex >= row.outputSwimlanes.length || inputLane.id !== row.outputSwimlanes[outputSwimlaneIndex].id) continue;
		if (index === outputSwimlaneIndex) {
			appendPath(svg, `M ${LaneWidth * (index + 1)} 0 V ${LaneHeight}`, inputLane.color);
		} else {
			appendPath(svg, `M ${LaneWidth * (index + 1)} 0 V 6 A ${CurveRadius} ${CurveRadius} 0 0 1 ${(LaneWidth * (index + 1)) - CurveRadius} ${LaneHeight / 2} H ${(LaneWidth * (outputSwimlaneIndex + 1)) + CurveRadius} A ${CurveRadius} ${CurveRadius} 0 0 0 ${LaneWidth * (outputSwimlaneIndex + 1)} ${(LaneHeight / 2) + CurveRadius} V ${LaneHeight}`, inputLane.color);
		}
		outputSwimlaneIndex += 1;
	}

	for (let index = 1; index < row.historyItem.parentIds.length; index += 1) {
		// createRows appends a distinct lane for every additional parent. Use its
		// position because summary nodes can replace its ID while an unrelated
		// lane still targets the original parent commit.
		const parentOutputIndex = row.outputSwimlanes.length - row.historyItem.parentIds.length + index;
		const parentColorIndex = row.outputSwimlanes[parentOutputIndex].color;
		appendPath(svg, `M ${LaneWidth * parentOutputIndex} ${LaneHeight / 2} A ${LaneWidth} ${LaneWidth} 0 0 1 ${LaneWidth * (parentOutputIndex + 1)} ${LaneHeight}`, parentColorIndex);
		appendPath(svg, `M ${LaneWidth * parentOutputIndex} ${LaneHeight / 2} H ${LaneWidth * (circleIndex + 1)}`, parentColorIndex);
	}

	if (inputIndex !== -1) appendPath(svg, `M ${LaneWidth * (circleIndex + 1)} 0 V ${LaneHeight / 2}`, row.inputSwimlanes[inputIndex].color);
	if (row.historyItem.parentIds.length > 0) appendPath(svg, `M ${LaneWidth * (circleIndex + 1)} ${LaneHeight / 2} V ${LaneHeight}`, circleColorIndex);
	if (expandedHeight > LaneHeight) {
		for (let index = 0; index < row.outputSwimlanes.length; index += 1) {
			appendPath(svg, `M ${LaneWidth * (index + 1)} ${LaneHeight} V ${expandedHeight}`, row.outputSwimlanes[index].color);
		}
	}
	appendNode(svg, circleIndex, kind, circleColorIndex);
	svg.dataset.nodeX = String(LaneWidth * (circleIndex + 1));
	// Include the title gutter in the graph width so expanded changes share its alignment.
	svg.style.width = `${LaneWidth * (Math.max(row.inputSwimlanes.length, row.outputSwimlanes.length, 1) + 1) + 4}px`;
	svg.style.height = `${LaneHeight}px`;
	return svg;
}

/** Continues a commit's outgoing lanes through an independently selectable child row. */
export function renderSCMHistoryGraphPlaceholder(columns: readonly ISCMHistoryItemGraphNode[], document: Document = globalThis.document): SVGSVGElement {
	const svg = createSvgElement(document, 'svg');
	svg.classList.add('ash-scm-graph-graph');
	svg.setAttribute('aria-hidden', 'true');
	for (const [index, lane] of columns.entries()) {
		appendPath(svg, `M ${LaneWidth * (index + 1)} 0 V ${LaneHeight}`, lane.color);
	}
	svg.style.width = `${LaneWidth * (Math.max(columns.length, 1) + 1) + 4}px`;
	svg.style.height = `${LaneHeight}px`;
	return svg;
}

function appendPath(svg: SVGSVGElement, data: string, colorIndex: number): SVGPathElement {
	const path = createSvgElement(svg.ownerDocument, 'path');
	path.classList.add('ash-scm-graph-path');
	path.dataset.laneColor = String(colorIndex);
	path.setAttribute('d', data);
	svg.append(path);
	return path;
}

function appendNode(svg: SVGSVGElement, index: number, kind: GraphNodeKind, colorIndex: number): void {
	if (kind === 'incoming-changes' || kind === 'outgoing-changes') {
		appendCircle(svg, index, 7, 'outer', colorIndex);
		appendCircle(svg, index, 5, 'inner', colorIndex);
		appendCircle(svg, index, 5, 'dashed', colorIndex);
		return;
	}
	if (kind === 'head') {
		appendCircle(svg, index, 7, 'outer', colorIndex);
		appendCircle(svg, index, 2, 'inner', colorIndex);
		return;
	}
	if (kind === 'merge') {
		appendCircle(svg, index, 6, 'outer', colorIndex);
		appendCircle(svg, index, 3, 'inner', colorIndex);
		return;
	}
	appendCircle(svg, index, 5, 'single', colorIndex);
}

function appendCircle(svg: SVGSVGElement, index: number, radius: number, part: 'inner' | 'outer' | 'single' | 'dashed', colorIndex: number): void {
	const circle = createSvgElement(svg.ownerDocument, 'circle');
	circle.classList.add('ash-scm-graph-node', part);
	circle.dataset.laneColor = String(colorIndex);
	circle.setAttribute('cx', `${LaneWidth * (index + 1)}`);
	circle.setAttribute('cy', `${LaneHeight / 2}`);
	circle.setAttribute('r', `${radius}`);
	svg.append(circle);
}

interface HistoryItemHoverContent {
	readonly domNode: HTMLDivElement;
	readonly toolbar: WorkbenchToolBar;
}

/** Shared pointer, keyboard and resource lifetime for commit cards in either history presentation. */
export function setupHistoryItemHover(
	options: {
		readonly resources: DisposableStore;
		readonly target: HTMLElement;
		readonly render: (resources: DisposableStore, layout: () => void) => HistoryItemHoverContent;
	},
	hoverService: IHoverService,
	contextViewService: IContextViewService,
): { readonly hover: IManagedHover; readonly focus: () => void; } {
	const lifetime = options.resources.add(new MutableDisposable<DisposableStore>());
	let toolbar: WorkbenchToolBar | undefined;
	let returnFocus: HTMLElement | undefined;
	const hover = options.resources.add(hoverService.setupHover({
		target: options.target,
		content: () => {
			const resources = new DisposableStore();
			lifetime.value = resources;
			const layout = () => { if (hover.visible) contextViewService.layout(); };
			const card = options.render(resources, layout);
			toolbar = card.toolbar;
			return card.domNode;
		},
		groupId: 'scm.history.items',
		trapFocus: true,
		persistence: 'transient',
		anchorAlignment: AnchorAlignment.Left,
		anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
		anchorPosition: AnchorPosition.Below,
		gap: 8,
		onDidHide: () => {
			lifetime.clear();
			toolbar = undefined;
			const target = returnFocus;
			returnFocus = undefined;
			// A row anchors the card, while an active-descendant tree owns keyboard focus.
			if (target?.isConnected && target.ownerDocument.activeElement === target.ownerDocument.body) target.focus();
		},
	}));
	return {
		hover, focus: () => {
			const active = options.target.ownerDocument.activeElement;
			returnFocus = isHTMLElement(active) ? active : undefined;
			toolbar?.focus();
		}
	};
}

interface SCMHistoryItemHoverOptions {
	readonly resources: DisposableStore;
	readonly target: HTMLElement;
	readonly historyItem: ISCMHistoryItem;
	readonly references: readonly ISCMHistoryItemRef[];
	readonly scope: IScopedContextKeyService;
	readonly layout: () => void;
	readonly openChanges: () => unknown;
}

/** The graph and file timeline render the same card; the caller owns its hover lifetime. */
export function toHistoryItemHoverContent(
	options: SCMHistoryItemHoverOptions,
	contextMenuService: IContextMenuService,
	clipboardService: IClipboardService,
	openerService: IOpenerService,
	accessibleView: IAccessibleViewService,
): { domNode: HTMLDivElement; toolbar: WorkbenchToolBar; } {
	const resources = options.resources;
	const historyItem = options.historyItem;
	const document = options.target.ownerDocument;
	const hover = h(document, 'div');
	hover.className = 'ash-scm-graph-hover';
	const hoverScope = resources.add(options.scope.createScoped(hover));
	hoverScope.setContext('scmHistoryDetailsFocused', true);
	const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.ScmHistoryDetails);
	if (hint) hover.setAttribute('aria-description', hint);
	const details = h(document, 'div');
	details.className = 'ash-scm-graph-hover-details';
	details.setAttribute('aria-busy', 'false');
	if (historyItem.tooltip) {
		renderCommitDetails(details, historyItem.subject, historyItem.tooltip, resources, options.layout, openerService);
	} else {
		// Providers without rich tooltip content still expose their complete message synchronously.
		details.textContent = historyItem.message || historyItem.subject;
	} const footer = h(document, 'div');
	footer.className = 'ash-scm-graph-hover-footer';
	const hash = h(document, 'div');
	hash.className = 'ash-scm-graph-hover-hash';
	hash.title = historyItem.id;
	const openLabel = localize('scm.history.openCommit', 'Open Commit {0}', historyItem.displayId ?? historyItem.id);
	const hashToolbar = resources.add(new WorkbenchToolBar(hash, contextMenuService, {
		ariaLabel: openLabel,
		actionViewItemProvider: (action, options) => new LabelActionViewItem(action, { ...options, ariaLabel: openLabel, tooltip: openLabel }),
	}));
	hashToolbar.setActions([{ id: 'workbench.scm.action.graph.viewChanges', label: historyItem.displayId ?? historyItem.id, tooltip: openLabel, enabled: true, run: () => options.openChanges() }]);
	const actions = h(document, 'div');
	actions.className = 'ash-scm-graph-hover-actions';
	const toolbar = resources.add(new WorkbenchToolBar(actions, contextMenuService, {
		ariaLabel: localize('scm.history.commitActions', 'Commit actions'),
		actionViewItemProvider: (action, options) => new LabelActionViewItem(action, { ...options, ariaLabel: action.tooltip, tooltip: action.tooltip }),
	}));
	const copyLabel = localize('scm.history.copyHash', 'Copy Commit Hash');
	const hoverActions: IAction[] = [{
		id: 'scm.history.copyHash', label: '', tooltip: copyLabel, icon: Lxicon.copy, enabled: true,
		run: () => clipboardService.writeText(historyItem.id),
	}];
	const hostingNames: Readonly<Record<string, string>> = { 'github.com': 'GitHub', 'gitlab.com': 'GitLab', 'bitbucket.org': 'Bitbucket' };
	for (const [index, link] of (historyItem.remoteLinks ?? []).entries()) {
		const label = localize('scm.history.openRemote', 'Open on {0}', hostingNames[link.uri.authority] ?? link.name);
		hoverActions.push({
			id: `scm.history.openRemote.${index}`, label, tooltip: label, icon: Lxicon.linkExternal, enabled: true,
			run: () => openerService.open(link.uri, { openExternal: true, fromUserGesture: true, allowContributedOpeners: true }),
		});
	}
	toolbar.setActions(hoverActions);
	if (hint) toolbar.element.setAttribute('aria-description', hint);
	footer.append(hash, actions);
	hover.append(details);
	const references = options.references;
	if (references.length > 0) {
		const labels = h(document, 'div');
		labels.className = 'ash-scm-graph-hover-references';
		labels.setAttribute('role', 'group');
		labels.setAttribute('aria-label', localize('scm.history.references', 'History references'));
		for (const reference of references) {
			const label = h(document, 'span');
			label.className = 'ash-scm-graph-label';
			appendIcon(reference.category === 'tag' ? Lxicon.tag : reference.category === 'remoteBranch' ? Lxicon.cloud : Lxicon.gitBranch, label);
			label.append(document.createTextNode(reference.name));
			labels.append(label);
		}
		hover.append(labels);
	}
	hover.append(footer);
	return { domNode: hover, toolbar };
}

function renderCommitDetails(container: HTMLElement, subjectText: string, details: ISCMHistoryItemDetails, resources: DisposableStore, layout: () => void, openerService: IOpenerService): void {
	const document = container.ownerDocument;
	const author = h(document, 'div');
	author.className = 'ash-scm-graph-hover-author';
	appendIcon(Lxicon.account, author);
	const name = h(document, 'span');
	name.textContent = details.authorName;
	name.title = details.authorEmail;
	const time = h(document, 'time');
	time.className = 'ash-scm-graph-hover-time';
	const date = new Date(details.timestamp);
	time.dateTime = date.toISOString();
	const seconds = Math.round((details.timestamp - Date.now()) / 1000);
	const units = [{ unit: 'year', seconds: 31_536_000 }, { unit: 'month', seconds: 2_592_000 }, { unit: 'day', seconds: 86_400 }, { unit: 'hour', seconds: 3_600 }, { unit: 'minute', seconds: 60 }, { unit: 'second', seconds: 1 }] as const;
	const unit = units.find(candidate => Math.abs(seconds) >= candidate.seconds) ?? units.at(-1)!;
	const relative = new Intl.RelativeTimeFormat(getNLSLanguage(), { numeric: 'auto' }).format(Math.round(seconds / unit.seconds), unit.unit);
	time.textContent = localize('scm.history.commitTime', '{0} ({1})', relative, date.toLocaleString(getNLSLanguage()));
	author.append(name, time);
	const subject = h(document, 'div');
	subject.className = 'ash-scm-graph-hover-subject';
	subject.textContent = subjectText;
	const message = h(document, 'div');
	message.className = 'ash-scm-graph-hover-message';
	const body = details.message.startsWith(subjectText) ? details.message.slice(subjectText.length).replace(/^\n+/, '') : details.message;
	// Commit text uses Markdown without granting HTML or command-link trust.
	resources.add(renderMarkdown({ value: body }, {
		markedOptions: { breaks: true },
		actionHandler: (href, markdown) => { void openLinkFromMarkdown(openerService, href, markdown.isTrusted); },
	}, message));
	const statistics = h(document, 'div');
	statistics.className = 'ash-scm-graph-hover-statistics';
	const files = h(document, 'span');
	files.textContent = localize('scm.history.filesChanged', '{0} files changed', details.statistics.files);
	const additions = h(document, 'span');
	additions.className = 'ash-scm-graph-hover-additions';
	additions.textContent = localize('scm.history.additions', '{0} insertions(+)', details.statistics.additions);
	const deletions = h(document, 'span');
	deletions.className = 'ash-scm-graph-hover-deletions';
	deletions.textContent = localize('scm.history.deletions', '{0} deletions(-)', details.statistics.deletions);
	statistics.append(files, additions, deletions);
	container.replaceChildren(author, subject);
	if (body) {
		const scrollable = resources.add(new ScrollableElement(container, { direction: 'vertical', ariaLabel: localize('scm.history.message', 'Commit message') }));
		scrollable.element.classList.add('ash-scm-graph-hover-message-scroll');
		scrollable.setContent(message);
		// A hover relayout may resize the observed message; leave the observer delivery before writing geometry.
		const resize = resources.add(new AnimationFrameScheduler(getWindow(message), () => {
			const height = Math.min(180, message.scrollHeight);
			if (scrollable.element.style.height !== `${height}px`) {
				scrollable.element.style.height = `${height}px`;
				layout();
			}
			scrollable.layout();
		}));
		resources.add(observeResize(message, () => resize.schedule()));
	}
	container.append(statistics);
}
