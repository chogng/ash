import './agentTraceEditor.css';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { triggerDownload } from '../../../../base/browser/fileAccess.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { isRecord } from '../../../../base/common/types.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId, AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput, IEditorPane, IEditorControl } from '../../../common/editor.js';
import { IChatService } from '../../../services/chat/common/chatService.js';
import { readAgentTraceLocation, type AgentTraceLocation } from '../common/trace.js';
import { diagnosticPayload, mergeAgentTrace, mergeAgentTraceDiagnostics, parseAgentTrace, type AgentTrace, type AgentTraceEvent, type AgentTraceGraph } from '../../../services/chat/common/agentTrace.js';

import { ObjectTree } from '../../../../base/browser/ui/tree/objectTree.js';
import { TreeVisibility } from '../../../../base/browser/ui/tree/tree.js';
import { SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
import { TabList } from '../../../../base/browser/ui/tablist/tabList.js';
import { IconLabel } from '../../../../base/browser/ui/iconlabel/iconlabel.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { List } from '../../../../base/browser/ui/list/listWidget.js';
import { CountBadge } from '../../../../base/browser/ui/countBadge/countBadge.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { IAction } from '../../../../base/common/actions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { AgentTraceViewModel, eventLabel, recordingLabel, evidenceLabel, relationLabel, type TraceEntry } from './agentTraceModel.js';

type DetailTab = 'overview' | 'input' | 'output' | 'relations' | 'raw';
interface TraceRelation { readonly id: string; readonly label: string; readonly target?: TraceEntry; }
let detailSequence = 0;

export const agentTraceEditorId = 'ash.agentTrace';

/** Owns a read-only capture and reference-counted subscriptions only while its input is open. */
export class AgentTraceEditor extends EditorPane implements IEditorPane {
	public readonly id = agentTraceEditorId;
	private domNode!: HTMLDivElement;
	private statusDomNode!: HTMLParagraphElement;
	private summaryDomNode!: HTMLParagraphElement;
	private locationDomNode!: HTMLParagraphElement;
	private bodyDomNode!: HTMLDivElement;
	private navigationDomNode!: HTMLDivElement;
	private inspectorDomNode!: HTMLDivElement;
	private treeDomNode!: HTMLDivElement;
	private detailsDomNode!: HTMLDivElement;
	private panelDomNode!: HTMLDivElement;
	private inspectorTitle!: HTMLHeadingElement;
	private inspectorIdentity!: HTMLParagraphElement;
	private bodyEditorHost!: HTMLDivElement;
	private relationsDomNode!: HTMLDivElement;
	private relationWarning!: HTMLParagraphElement;
	private emptyTree!: HTMLParagraphElement;
	private filter!: InputBox;
	private errorsButton!: Button;
	private toolbar!: WorkbenchToolBar;
	private refreshAction!: IAction;
	private secondaryActions!: readonly IAction[];
	private tree!: ObjectTree<TraceEntry>;
	private tabs!: TabList<DetailTab>;
	private relationList!: List<TraceRelation>;
	private detailScroll!: ScrollableElement;
	private count!: CountBadge;
	private progress!: ProgressBar;
	private viewModel = new AgentTraceViewModel();
	private tab: DetailTab = 'overview';
	private readonly panelId = `ash-trace-detail-${++detailSequence}`;
	private readonly split = this._register(new MutableDisposable<SplitView>());
	private readonly inspectorResources = this._register(new DisposableStore());
	private readonly bodyEditor = this._register(new MutableDisposable<CodeEditorWidget>());
	private readonly bodyModel = this._register(new MutableDisposable<ITextModel>());
	private readonly rowLabels = new Map<HTMLElement, IconLabel>();
	private filteredCollapse: Map<string, boolean> | undefined;
	private filterKey = '';
	private dimension: IDimension = { width: 900, height: 600 };
	private detailValue: unknown;
	private detailIdentity: string | undefined;
	private detailText = '';
	private bodySectionIdentity: string | undefined;
	private graphRequest: Promise<AgentTraceGraph> | undefined;
	private trace: AgentTrace | undefined;
	private sessionId: string | undefined;
	private location: AgentTraceLocation | undefined;
	private locationKey: string | undefined;
	private locationReadComplete = false;
	private cursors: Readonly<Record<string, number>> = {};
	private diagnosticCursor = 0;
	private readonly diagnosticPoll = this._register(new RunOnceScheduler(() => this.requestRefresh(), 1000));
	private readonly subscriptions = new Set<string>();
	private subscriptionOwner: object = {};
	private revision = 0;
	private importSelection = 0;
	private exportOperation: object | undefined;
	private loading = false;
	private dirty = false;
	private isShown = true;
	private inputSignal: AbortSignal | undefined;
	private errorsOnly = false;
	private selected: string | undefined;
	private readonly pendingInput = this._register(new MutableDisposable<IDisposable>());
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => { void this.refresh(); }, 100));

	constructor(
		@IChatService private readonly chat: IChatService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IModelService private readonly models: IModelService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super(agentTraceEditorId, theme, storage);
		this._register(chat.onDidUpdateThread(event => {
			if (event.sessionId === this.sessionId && event.durableSequence > (this.cursors[event.threadId] ?? 0)) { this.requestRefresh(); }
		}));
		this._register(chat.onDidBecomeReady(() => {
			this.subscriptions.clear();
			this.requestRefresh();
		}));
		this._register(chat.onDidChangeSession(event => {
			if (event.sessionId === this.sessionId) { this.requestRefresh(); }
		}));
		this._register(toDisposable(() => this.clearInput()));
	}

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.domNode = h(document, 'div', { className: 'ash-agent-trace' });
		const context = this._register(this.contextKeys.createScoped(this.domNode));
		context.createKey('agentTraceFocused', true);
		this.domNode.setAttribute('aria-label', localize('agentTrace.title', 'Execution Trace'));
		const updateHint = (): void => {
			const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.AgentTrace);
			if (hint) { this.domNode.setAttribute('aria-description', hint); }
			else { this.domNode.removeAttribute('aria-description'); }
		};
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.AgentTrace)) { updateHint(); }
		}));
		updateHint();
		const header = h(document, 'div', { className: 'ash-agent-trace-header' });
		const title = h(document, 'h1');
		title.textContent = localize('agentTrace.title', 'Execution Trace');
		this.statusDomNode = h(document, 'p', { className: 'ash-agent-trace-status' });
		this.statusDomNode.setAttribute('role', 'status');
		const actions = h(document, 'div', { className: 'ash-agent-trace-actions' });
		this.toolbar = this._register(new WorkbenchToolBar(actions, this.contextMenus, { ariaLabel: localize('agentTrace.actions', 'Trace actions') }));
		this.refreshAction = { id: 'trace.refresh', label: localize('agentTrace.refresh', 'Refresh'), tooltip: '', icon: Lxicon.refresh, enabled: true, run: () => this.requestRefresh() };
		const file = h(document, 'input');
		file.type = 'file'; file.accept = '.json'; file.hidden = true;
		file.setAttribute('aria-label', localize('agentTrace.import', 'Import trace'));
		const editor = this;
		this.secondaryActions = [
			{ id: 'trace.import', label: localize('agentTrace.import', 'Import trace'), tooltip: '', enabled: true, run: () => file.click() },
			{ id: 'trace.export', label: localize('agentTrace.export', 'Export trace'), tooltip: '', get enabled() { return !!editor.trace && !editor.exportOperation; }, run: () => { if (!editor.exportOperation) { void editor.exportTrace(); } } },
			{ id: 'trace.help', label: localize('agentTrace.help', 'Help'), tooltip: '', enabled: true, run: () => this.accessibleViews.show(AccessibleViewType.Help) },
		];
		this.toolbar.setActions([this.refreshAction], this.secondaryActions);
		this._register(addDisposableListener(file, 'change', () => {
			const selected = file.files?.[0];
			if (selected) { void this.importFile(selected); }
			file.value = '';
		}));
		header.append(title, this.statusDomNode, actions);
		this.locationDomNode = h(document, 'p', { className: 'ash-agent-trace-location' });
		this.locationDomNode.setAttribute('aria-live', 'polite');
		this.progress = this._register(new ProgressBar(this.domNode));
		this.progress.element.hidden = true;
		this.bodyDomNode = h(document, 'div', { className: 'ash-agent-trace-body' });
		this.navigationDomNode = h(document, 'div', { className: 'ash-agent-trace-navigation' });
		const structure = h(document, 'div', { className: 'ash-agent-trace-structure' });
		const structureTitle = h(document, 'h2');
		structureTitle.textContent = localize('agentTrace.structure', 'Execution structure');
		this.count = this._register(new CountBadge(structure, { size: 'small', titleFormat: localize('agentTrace.count', '{0} matching events') }));
		structure.prepend(structureTitle);
		const search = h(document, 'div', { className: 'ash-agent-trace-search' });
		this.filter = this._register(new InputBox(search, { presentation: 'compact', ariaLabel: localize('agentTrace.filter', 'Filter execution events'), placeholder: localize('agentTrace.filter', 'Filter execution events') }));
		this.errorsButton = this._register(new Button(search, {
			presentation: 'secondary', label: localize('agentTrace.errors', 'Errors only'), onClick: () => {
				this.errorsOnly = !this.errorsOnly; this.errorsButton.checked = this.errorsOnly; this.render();
			}
		}));
		this.errorsButton.checked = false;
		this._register(this.filter.onDidChange(() => this.render()));
		this.summaryDomNode = h(document, 'p', { className: 'ash-agent-trace-summary' });
		this.treeDomNode = h(document, 'div', { className: 'ash-agent-trace-tree' });
		this.tree = this._register(new ObjectTree<TraceEntry>(this.treeDomNode, {
			ariaLabel: localize('agentTrace.timeline', 'Execution timeline'), scrolling: 'managed', getHeight: () => 24,
			indent: 12, indentGuides: 'onHover', expandOnlyOnTwistieClick: true,
			modelOptions: { identityProvider: { getId: entry => entry.id }, filter: { filter: entry => entry.kind === 'event' ? this.viewModel.matched.has(entry.id) : TreeVisibility.Recurse } },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: entry => entry.label },
			renderElement: entry => {
				const root = h(document, 'span', { className: `ash-agent-trace-row ash-agent-trace-${entry.kind}` });
				root.dataset.traceRow = entry.id;
				root.dataset.threadId = entry.threadId;
				if (entry.turnId) { root.dataset.turnId = entry.turnId; }
				if (entry.key) { root.dataset.key = entry.key; }
				if (entry.record) { root.dataset.eventId = entry.record.eventId; }
				const type = entry.record?.event.type;
				const label = new IconLabel(root, { label: entry.label, description: entry.description, icon: entry.kind === 'thread' ? Lxicon.chat1 : type?.startsWith('model') ? Lxicon.sparkle : isRecord(entry.record?.event.item) && String(entry.record.event.item.type).startsWith('tool') ? Lxicon.terminal : Lxicon.history, title: [entry.threadId, entry.turnId, entry.record?.eventId, entry.record && eventLabel(entry.record)].filter(Boolean).join(' · ') });
				this.rowLabels.set(root, label);
				if (entry.failed) {
					const failure = h(document, 'span', { className: 'ash-agent-trace-failure' });
					failure.textContent = localize('agentTrace.failedShort', 'Failed'); root.append(failure);
				}
				return root;
			},
			onDidRemoveRow: row => {
				const root = row.querySelector<HTMLElement>('[data-trace-row]');
				if (root) { this.rowLabels.get(root)?.dispose(); this.rowLabels.delete(root); }
			},
		}));
		this._register(this.tree.onDidChangeSelection(({ elements, browserEvent }) => { if (browserEvent && elements[0]) { this.select(elements[0].id); } }));
		this.emptyTree = h(document, 'p', { className: 'ash-agent-trace-empty' });
		this.navigationDomNode.append(structure, search, this.treeDomNode, this.emptyTree, this.summaryDomNode);
		this.inspectorDomNode = h(document, 'div', { className: 'ash-agent-trace-inspector' });
		this.inspectorTitle = h(document, 'h2', { className: 'ash-agent-trace-inspector-title' });
		this.inspectorIdentity = h(document, 'p', { className: 'ash-agent-trace-inspector-identity' });
		// TabList fills its host; reserve one row instead of the entire inspector.
		const tabHost = h(document, 'div', { className: 'ash-agent-trace-tabs' });
		this.inspectorDomNode.append(tabHost);
		this.tabs = this._register(new TabList<DetailTab>(tabHost, { ariaLabel: localize('agentTrace.detailTabs', 'Execution details'), presentation: 'flush', onActivate: tab => { this.tab = tab; this.renderInspector(); } }));
		this.inspectorDomNode.prepend(this.inspectorTitle, this.inspectorIdentity);
		this.panelDomNode = h(document, 'div', { className: 'ash-agent-trace-panel' });
		this.panelDomNode.id = this.panelId;
		this.panelDomNode.setAttribute('role', 'tabpanel');
		this.detailScroll = this._register(new ScrollableElement(this.panelDomNode, { direction: 'vertical', tabIndex: -1 }));
		// The scrollbar root owns the pane's flex allocation; an extra block wrapper
		// would leave its absolute viewport without a height.
		this.detailScroll.element.classList.add('ash-agent-trace-detail-host');
		this.detailsDomNode = h(document, 'div', { className: 'ash-agent-trace-details' });
		this.detailsDomNode.tabIndex = 0;
		this.detailScroll.setContent(this.detailsDomNode);
		this.bodyEditorHost = h(document, 'div', { className: 'ash-agent-trace-code' });
		this.relationsDomNode = h(document, 'div', { className: 'ash-agent-trace-relations' });
		this.relationList = this._register(new List<TraceRelation>(this.relationsDomNode, {
			ariaLabel: localize('agentTrace.relations', 'View relationships'), scrolling: 'managed', keyboardNavigation: true, getHeight: () => 32,
			getId: item => item.id, renderItem: item => {
				const label = h(document, 'span', { className: 'ash-agent-trace-relation' });
				label.textContent = item.label;
				if (item.target) { label.dataset.key = item.target.key; }
				else { label.setAttribute('aria-disabled', 'true'); }
				return label;
			},
		}));
		this._register(this.relationList.onDidAccept(({ item }) => {
			if (!item.target) { return; }
			this.errorsOnly = false; this.errorsButton.checked = false; this.filter.value = ''; this.render();
			this.select(item.target.id, true); this.tree.domFocus();
		}));
		this.relationWarning = h(document, 'p', { className: 'ash-agent-trace-relation-warning' });
		this.panelDomNode.append(this.bodyEditorHost, this.relationsDomNode, this.relationWarning);
		this.inspectorDomNode.append(this.panelDomNode);
		this.domNode.append(header, file, this.locationDomNode, this.bodyDomNode);
		parent.append(this.domNode);
		super.create(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.configureSplit(false);
		this.render();
	}

	private configureSplit(narrow: boolean): void {
		if (this.split.value?.orientation === (narrow ? 'vertical' : 'horizontal')) { return; }
		// Pane roots and widget owners survive orientation changes; only the Sash layout is replaced.
		this.navigationDomNode.remove(); this.inspectorDomNode.remove();
		this.split.value = new SplitView(this.bodyDomNode, narrow ? 'vertical' : 'horizontal', { styles: { separatorBorder: 'var(--ash-widget-border)' } });
		this.split.value.addView({ element: this.navigationDomNode, minimumSize: narrow ? 120 : 200, maximumSize: Number.POSITIVE_INFINITY, layout: (size, _offset, other) => this.layoutNavigation(narrow ? other : size, narrow ? size : other) }, (narrow ? this.dimension.height : this.dimension.width) * 0.35);
		this.split.value.addView({ element: this.inspectorDomNode, minimumSize: narrow ? 160 : 240, maximumSize: Number.POSITIVE_INFINITY, layout: (size, _offset, other) => this.layoutInspector(narrow ? other : size, narrow ? size : other) }, (narrow ? this.dimension.height : this.dimension.width) * 0.65);
	}

	private layoutNavigation(width: number, height: number): void {
		this.navigationDomNode.style.width = `${width}px`; this.navigationDomNode.style.height = `${height}px`;
		this.tree.domNode.style.height = `${Math.max(0, height - 112)}px`;
	}
	private layoutInspector(width: number, height: number): void {
		this.inspectorDomNode.style.width = `${width}px`; this.inspectorDomNode.style.height = `${height}px`;
		this.bodyEditor.value?.layout({ width: Math.max(0, width - 24), height: Math.max(0, height - 112) });
		this.relationList.layout(Math.max(0, height - 120));
		this.detailScroll.layout();
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		try { this.location = readAgentTraceLocation(input.resource); }
		catch (error) { this.statusDomNode.textContent = String(error); throw error; }
		this.sessionId = this.location?.sessionId;
		if (this.location?.threadId) {
			this.errorsOnly = false; this.errorsButton.checked = false; this.filter.value = '';
		}
		this.inputSignal = signal;
		const abort = (): void => { if (this.inputSignal === signal) { this.clearInput(); } };
		signal.addEventListener('abort', abort, { once: true });
		this.pendingInput.value = toDisposable(() => signal.removeEventListener('abort', abort));
		if (signal.aborted) { abort(); return; }
		if (this.sessionId) { await this.refresh(); }
		else { this.render(); }
	}

	public override clearInput(): void {
		this.revision++;
		this.importSelection++;
		this.exportOperation = undefined;
		this.pendingInput.clear();
		this.inputSignal = undefined;
		this.refreshScheduler.cancel();
		this.diagnosticPoll.cancel();
		this.releaseSubscriptions();
		this.sessionId = undefined;
		this.location = undefined;
		this.locationKey = undefined;
		this.locationReadComplete = false;
		this.trace = undefined;
		this.cursors = {};
		this.diagnosticCursor = 0;
		this.selected = undefined;
		this.loading = false;
		if (this.progress) { this.progress.element.hidden = true; }
		this.dirty = false;
		this.viewModel = new AgentTraceViewModel();
		this.filteredCollapse = undefined; this.filterKey = '';
		this.detailIdentity = undefined; this.detailValue = undefined;
		this.bodySectionIdentity = undefined; this.graphRequest = undefined;
		this.bodyEditor.clear(); this.bodyModel.clear();
		this.inspectorResources.clear();
		this.tab = 'overview';
		this.relationWarning && (this.relationWarning.textContent = '');
		if (!this.isDisposed) { this.tree?.setChildren([]); if (this.relationList) { this.relationList.items = []; } }
		this.render();
	}

	private releaseSubscriptions(): void {
		const sessionId = this.sessionId;
		const owner = this.subscriptionOwner;
		for (const threadId of this.subscriptions) {
			if (sessionId) { void this.chat.unsubscribeThread(sessionId, threadId, owner).catch(onUnexpectedError); }
		}
		this.subscriptions.clear();
		this.subscriptionOwner = {};
	}

	private requestRefresh(): void {
		if (!this.sessionId || !this.isShown) { return; }
		this.dirty = true;
		this.refreshScheduler.schedule();
	}

	private async refresh(): Promise<void> {
		if (!this.sessionId || !this.isShown || this.loading || this.isDisposed) { return; }
		const sessionId = this.sessionId;
		const revision = this.revision;
		const owner = this.subscriptionOwner;
		this.loading = true;
		this.progress.element.hidden = false;
		this.progress.value = undefined;
		this.dirty = false;
		this.statusDomNode.textContent = localize('agentTrace.loading', 'Loading execution history…');
		try {
			let more = true;
			while (more && revision === this.revision && !this.isDisposed) {
				const page = await this.chat.readTrace(sessionId, this.cursors);
				if (revision !== this.revision || this.isDisposed) { return; }
				this.trace = mergeAgentTrace(this.trace, page.trace);
				this.cursors = page.cursors;
				more = page.hasMore;
				for (const thread of this.trace.threads) {
					if (this.subscriptions.has(thread.threadId)) { continue; }
					this.subscriptions.add(thread.threadId);
					try {
						const subscribed = await this.chat.subscribeThread(sessionId, thread.threadId, this.cursors[thread.threadId] ?? 0, owner);
						// The subscription snapshot closes the read/subscribe gap, including a Turn that
						// finishes before notifications become attached to this editor.
						if (revision === this.revision && subscribed.thread.sequence > (this.cursors[thread.threadId] ?? 0)) { this.dirty = true; }
					} catch (error) {
						if (revision === this.revision) { this.subscriptions.delete(thread.threadId); }
						await this.chat.unsubscribeThread(sessionId, thread.threadId, owner);
						throw error;
					}
					if (revision !== this.revision || this.isDisposed) {
						await this.chat.unsubscribeThread(sessionId, thread.threadId, owner);
						return;
					}
				}
				this.render();
			}
			let diagnosticMore = true;
			while (diagnosticMore && revision === this.revision && !this.isDisposed) {
				const page = await this.chat.readTraceDiagnostics(sessionId, this.diagnosticCursor);
				if (revision !== this.revision || this.isDisposed || !this.trace) { return; }
				this.trace = { ...this.trace, diagnostics: mergeAgentTraceDiagnostics(this.trace.diagnostics, page.diagnostics), graph: page.diagnostics.events.length ? undefined : this.trace.graph };
				this.diagnosticCursor = page.cursor;
				diagnosticMore = page.hasMore;
			}
			this.locationReadComplete = true;
			this.render();
			this.statusDomNode.textContent = localize('agentTrace.live', 'Live · durable execution history');
		} catch (error) {
			if (revision === this.revision && !this.isDisposed) {
				this.statusDomNode.textContent = localize('agentTrace.failed', 'Could not load trace: {0}', String(error));
			}
		} finally {
			if (revision === this.revision && !this.isDisposed) {
				this.loading = false;
				this.progress.element.hidden = true;
				if (this.dirty) { this.refreshScheduler.schedule(); }
				if (this.isShown && this.sessionId && ['recording', 'incomplete'].includes(this.trace?.diagnostics?.recordingStatus ?? '')) { this.diagnosticPoll.schedule(); }
			}
		}
	}

	private async importFile(file: File): Promise<void> {
		const revision = this.revision;
		// Selection order owns the result, even when a newer file fails before an older read.
		const selection = ++this.importSelection;
		try {
			if (file.size > 64 * 1024 * 1024) { throw new Error(localize('agentTrace.fileSize', 'Trace files must be smaller than 64 MiB.')); }
			const text = await file.text();
			if (revision !== this.revision || selection !== this.importSelection || this.isDisposed) { return; }
			const trace = parseAgentTrace(JSON.parse(text));
			this.clearInput();
			this.trace = trace;
			this.statusDomNode.textContent = localize('agentTrace.imported', 'Imported · {0}', file.name);
			this.render();
		} catch (error) {
			if (revision === this.revision && selection === this.importSelection && !this.isDisposed) { this.statusDomNode.textContent = localize('agentTrace.failed', 'Could not load trace: {0}', String(error)); }
		}
	}

	private render(): void {
		if (!this.domNode || this.isDisposed) { return; }
		this.locationDomNode.hidden = !this.location?.threadId;
		if (!this.location?.threadId) { this.locationDomNode.textContent = ''; }
		const changed = this.viewModel.update(this.trace);
		const query = this.filter.value.toLowerCase();
		this.viewModel.filter(query, this.errorsOnly);
		if (changed) { this.tree.setChildren(this.viewModel.roots); }
		else { this.tree.model.refilter(); }
		const filterKey = JSON.stringify([query, this.errorsOnly]);
		const filtering = !!query || this.errorsOnly;
		if (filtering) {
			this.filteredCollapse ??= new Map([...this.viewModel.entries.values()].filter(entry => entry.kind !== 'event').map(entry => [entry.id, this.tree.isCollapsed(entry.id) ?? false]));
			if (this.filterKey !== filterKey || changed) {
				for (const id of this.viewModel.matched) { this.tree.expandTo(id); }
			}
		} else if (this.filteredCollapse) {
			for (const [id, collapsed] of this.filteredCollapse) {
				if (this.tree.model.has(id)) { if (collapsed) { this.tree.collapse(id); } else { this.tree.expand(id); } }
			}
			this.filteredCollapse = undefined;
		}
		this.filterKey = filterKey;
		this.count.setCount(this.viewModel.shownCount);
		this.emptyTree.hidden = this.viewModel.shownCount !== 0;
		this.emptyTree.textContent = this.trace ? localize('agentTrace.noMatches', 'No matching execution events.') : localize('agentTrace.empty', 'Open a saved conversation or import an evaluation trace.');
		this.summaryDomNode.textContent = this.trace ? localize('agentTrace.summary', '{0} Threads · {1} shown / {2} events.', this.trace.threads.length, this.viewModel.shownCount, this.viewModel.eventCount) : '';
		if (!this.trace) { this.statusDomNode.textContent = ''; }
		let located = false;
		if (this.location?.threadId && !this.locationKey) {
			this.locationKey = this.viewModel.findEvent(this.location.threadId, this.location.turnId, this.location.eventId)?.id;
			if (this.locationKey) { this.selected = this.locationKey; located = true; }
		}
		if (!this.selected && !this.location?.threadId) {
			this.selected = this.viewModel.matched.values().next().value;
			located = !!this.selected;
		}
		if (this.location?.threadId) {
			const identity = [this.location.threadId, this.location.turnId, this.location.eventId].filter(value => value !== undefined).join(' / ');
			const message = this.locationKey
				? this.viewModel.matched.has(this.locationKey) ? localize('agentTrace.locationFound', 'Located {0}.', identity) : localize('agentTrace.locationHidden', 'Located {0} · hidden by the display filter.', identity)
				: this.locationReadComplete ? localize('agentTrace.locationMissing', 'No saved execution event matches {0}.', identity) : localize('agentTrace.locationLoading', 'Finding saved execution event {0}…', identity);
			if (this.locationDomNode.textContent !== message) { this.locationDomNode.textContent = message; }
		}
		if (this.selected && located) { this.tree.expandTo(this.selected); this.tree.setFocus(this.selected); }
		if (this.selected) { this.tree.setSelection([this.selected]); }
		this.renderInspector();
	}

	private select(id: string, reveal = false): void {
		if (!this.viewModel.entries.has(id)) { return; }
		this.selected = id;
		if (reveal) { this.tree.expandTo(id); this.tree.setFocus(id); }
		this.tree.setSelection([id]);
		this.renderInspector();
	}

	private renderInspector(): void {
		const entry = this.selected && this.viewModel.entries.get(this.selected);
		const labels: Record<DetailTab, string> = {
			overview: localize('agentTrace.overview', 'Overview'), input: localize('agentTrace.inputTab', 'Input'), output: localize('agentTrace.outputTab', 'Output'), relations: localize('agentTrace.relationsTab', 'Relations'), raw: localize('agentTrace.rawTab', 'Raw record'),
		};
		this.tabs.setTabs((Object.keys(labels) as DetailTab[]).map(tab => ({ id: tab, value: tab, label: labels[tab], tabId: `${this.panelId}-${tab}`, panelId: this.panelId })), this.tab);
		this.panelDomNode.setAttribute('aria-labelledby', `${this.panelId}-${this.tab}`);
		this.inspectorTitle.textContent = entry ? entry.label : localize('agentTrace.details', 'Execution event details');
		this.inspectorIdentity.textContent = entry ? [entry.kind, entry.threadId, entry.turnId].filter(Boolean).join(' · ') : '';
		this.detailScroll.element.hidden = this.tab === 'relations' || this.tab === 'raw';
		this.relationsDomNode.hidden = this.tab !== 'relations';
		this.relationWarning.hidden = this.tab !== 'relations';
		this.bodyEditorHost.hidden = this.tab !== 'raw' && this.bodySectionIdentity !== `${this.selected}:${this.tab}`;
		if (this.tab === 'relations') { void this.loadRelationships(); return; }
		if (!entry) {
			this.detailsDomNode.textContent = this.location?.threadId ? this.locationDomNode.textContent : this.emptyTree.textContent;
			this.detailText = this.detailsDomNode.textContent ?? '';
			return;
		}
		const payload = this.viewModel.payload(entry, this.tab === 'output').ref;
		const body = payload && this.trace?.diagnostics?.payloads?.[payload.payloadId];
		const identity = `${entry.id}:${this.tab}`;
		const value = this.tab === 'input' || this.tab === 'output' ? body ?? payload ?? entry.record : entry.record ?? this.trace;
		if (identity === this.detailIdentity && value === this.detailValue) { return; }
		this.detailIdentity = identity; this.detailValue = value;
		if (this.bodySectionIdentity !== identity) { this.bodySectionIdentity = undefined; }
		this.inspectorResources.clear();
		this.detailsDomNode.replaceChildren();
		if (this.tab === 'raw') {
			const record = entry.record;
			const thread = this.trace?.threads.find(thread => thread.threadId === entry.threadId);
			this.showCode(record?.event.type === 'historyPrefixBound' ? { ...record, retainedHistoryPrefixes: this.trace?.historyPrefixes } : record ?? (entry.kind === 'thread' ? thread : { threadId: entry.threadId, turnId: entry.turnId, events: thread?.events.filter(record => record.event.turnId === entry.turnId) }));
			return;
		}
		if (this.tab === 'overview') {
			const fields = h(this.domNode.ownerDocument, 'dl');
			const field = (label: string, value: unknown): void => {
				if (value === undefined || value === null) { return; }
				const term = h(fields.ownerDocument, 'dt'); const definition = h(fields.ownerDocument, 'dd');
				term.textContent = label; definition.textContent = typeof value === 'string' ? value.slice(0, 1000) : String(value); fields.append(term, definition);
			};
			field(localize('agentTrace.typeField', 'Type'), entry.record?.event.type ?? entry.kind);
			field(localize('agentTrace.threadShort', 'Thread'), entry.threadId);
			field(localize('agentTrace.turnShort', 'Turn'), entry.turnId);
			if (entry.record) {
				field(localize('agentTrace.eventIdField', 'Event ID'), entry.record.eventId);
				field(localize('agentTrace.sequenceField', 'Sequence'), entry.record.sequence);
				field(localize('agentTrace.recordedField', 'Recorded at'), new Date(entry.record.recordedAt).toISOString());
				const event = entry.record.event;
				const invocation = isRecord(event.record) ? event.record : undefined;
				const error = event.error ?? (isRecord(event.item) && event.item.isError ? event.item.text : undefined);
				field(localize('agentTrace.errorField', 'Error'), isRecord(error) ? error.message ?? error.type : error);
				if (isRecord(event.decision)) {
					field(localize('agentTrace.decisionField', 'Decision'), eventLabel(entry.record));
				}
				field(localize('agentTrace.modelField', 'Model'), invocation?.resolvedModel);
				field(localize('agentTrace.outcomeField', 'Outcome'), invocation?.outcome);
				if (typeof invocation?.startedAtUnixMs === 'number' && typeof invocation.completedAtUnixMs === 'number' && invocation.completedAtUnixMs >= invocation.startedAtUnixMs) { field(localize('agentTrace.durationField', 'Model duration (ms)'), invocation.completedAtUnixMs - invocation.startedAtUnixMs); }
				if (isRecord(invocation?.usage)) {
					for (const [key, value] of Object.entries(invocation.usage)) { if (typeof value === 'number') { field(key, value); } }
				}
			} else { field(localize('agentTrace.eventsField', 'Saved events'), [...this.viewModel.entries.values()].filter(candidate => candidate.record && candidate.threadId === entry.threadId && (!entry.turnId || candidate.turnId === entry.turnId)).length); }
			this.detailsDomNode.append(fields);
			const recording = h(fields.ownerDocument, 'p'); recording.textContent = this.trace && recordingLabel(this.trace) || ''; this.detailsDomNode.append(recording);
		} else {
			void this.renderBody(entry, payload, body);
		}
		this.detailText = this.detailsDomNode.textContent ?? '';
		this.detailScroll.layout();
	}

	private async renderBody(entry: TraceEntry, payload: ReturnType<AgentTraceViewModel['payload']>['ref'], body: unknown): Promise<void> {
		const document = this.domNode.ownerDocument;
		const identity = this.detailIdentity;
		if (payload) {
			const label = h(document, 'p'); label.textContent = evidenceLabel(payload.kind); this.detailsDomNode.append(label);
			if (payload.status === 'omitted') { this.detailsDomNode.append(h(document, 'p', localize('agentTrace.payloadOmitted', 'Payload omitted by the recording limit.'))); }
			else if (body !== undefined) { this.renderBodySections(body); }
			else if (!this.sessionId || !this.trace?.diagnostics?.captureId) { this.detailsDomNode.append(h(document, 'p', localize('agentTrace.missingEvidence', 'This capture does not include the selected payload.'))); }
			else { await this.loadEvidence(entry, payload); }
		} else {
			const item = isRecord(entry.record?.event.item) ? entry.record.event.item : undefined;
			const value = this.tab === 'output' ? item?.type === 'agentMessage' || item?.type === 'toolResult' ? item.text ?? item : undefined : item?.type === 'userMessage' || item?.type === 'toolCall' ? item.arguments ?? item.text ?? item : entry.record?.event.type === 'turnAccepted' ? entry.record.event : undefined;
			if (value !== undefined) { this.renderBodySections(value); }
			else { this.detailsDomNode.append(h(document, 'p', this.trace?.diagnostics && this.trace.diagnostics.recordingStatus !== 'disabled' ? localize('agentTrace.noBody', 'No body is recorded for this event and tab.') : this.trace && recordingLabel(this.trace) || '')); }
		}
		if (identity === this.detailIdentity && !this.isDisposed) { this.detailText = this.detailsDomNode.textContent ?? ''; this.detailScroll.layout(); }
	}

	private renderBodySections(body: unknown): void {
		const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : undefined;
		const sections = messages ?? [body];
		for (let index = 0; index < sections.length; index++) {
			const section = sections[index];
			const role = isRecord(section) && typeof section.role === 'string' ? section.role : localize('agentTrace.bodySection', 'Saved body');
			this.inspectorResources.add(new Button(this.detailsDomNode, { presentation: 'secondary', label: `${role}${messages ? ` ${index + 1}` : ''}`, onClick: () => { this.bodySectionIdentity = this.detailIdentity; this.bodyEditorHost.hidden = false; this.showCode(isRecord(section) && section.content !== undefined ? section.content : section); } }));
		}
	}

	private showCode(value: unknown): void {
		const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
		if (!this.bodyEditor.value) {
			this.bodyEditor.value = this.instantiation.createInstance(CodeEditorWidget, { container: this.bodyEditorHost, model: null, readOnly: true, ariaLabel: localize('agentTrace.savedBody', 'Saved execution body'), lineNumbers: 'off', minimap: { enabled: false }, wordWrap: 'on', suggestions: { enabled: false }, inlineCompletions: { enabled: false } });
			// Saved bodies are transient text, without a file's resource configuration authority.
			this.bodyModel.value = this.models.createModel('', null, undefined, true);
			this.bodyEditor.value.setModel(this.bodyModel.value);
		}
		this.models.updateModel(this.bodyModel.value!, text);
		this.detailText = text;
		this.bodyEditor.value.layout({ width: Math.max(0, this.inspectorDomNode.clientWidth - 24), height: Math.max(0, this.inspectorDomNode.clientHeight - 112) });
	}

	private async loadEvidence(entry: TraceEntry, payload: NonNullable<ReturnType<AgentTraceViewModel['payload']>['ref']>): Promise<void> {
		const revision = this.revision;
		const identity = this.detailIdentity;
		try {
			const evidence = await this.chat.readTracePayload(this.sessionId!, this.trace!.diagnostics!.captureId!, payload.payloadId);
			if (revision !== this.revision || this.isDisposed || !this.trace?.diagnostics) { return; }
			this.trace = { ...this.trace, diagnostics: { ...this.trace.diagnostics, payloads: { ...this.trace.diagnostics.payloads, [payload.payloadId]: evidence } } };
			if (identity === this.detailIdentity && entry.id === this.selected) { this.renderInspector(); }
		} catch (error) { if (revision === this.revision && identity === this.detailIdentity && !this.isDisposed) { this.statusDomNode.textContent = localize('agentTrace.failed', 'Could not load trace: {0}', String(error)); } }
	}

	private async loadRelationships(): Promise<void> {
		if (!this.trace) { this.relationList.items = []; return; }
		const revision = this.revision;
		try {
			const graph = this.trace.graph ?? (this.sessionId ? await (this.graphRequest ??= this.chat.readTraceGraph(this.sessionId)) : undefined);
			if (revision === this.revision) { this.graphRequest = undefined; }
			if (revision !== this.revision || this.isDisposed || !this.trace || this.tab !== 'relations') { return; }
			if (graph) { this.trace = { ...this.trace, graph }; this.renderRelationships(graph); }
			else { this.relationList.items = []; this.relationWarning.textContent = localize('agentTrace.noRelationships', 'No saved relationships for this capture.'); }
		} catch (error) { if (revision === this.revision && !this.isDisposed) { this.graphRequest = undefined; this.statusDomNode.textContent = localize('agentTrace.failed', 'Could not load trace: {0}', String(error)); } }
	}

	private renderRelationships(graph: AgentTraceGraph): void {
		const selected = new Set(Object.values(graph.nodes).filter(node => this.viewModel.graphTarget(node)?.id === this.selected).map(node => node.id));
		this.relationList.items = graph.edges.filter(edge => selected.has(edge.from) || selected.has(edge.to)).map((edge, index) => {
			const outgoing = selected.has(edge.from);
			const target = graph.nodes[outgoing ? edge.to : edge.from];
			return { id: `${index}:${edge.from}:${edge.to}:${edge.kind}`, label: `${outgoing ? localize('agentTrace.outgoing', 'Outgoing') : localize('agentTrace.incoming', 'Incoming')} · ${relationLabel(edge.kind)} · ${target.label}`, target: this.viewModel.graphTarget(target) };
		});
		this.relationWarning.textContent = graph.warnings.length ? graph.warnings.join('\n') : this.relationList.items.length ? '' : localize('agentTrace.noRelationships', 'No saved relationships for this capture.');
	}

	private async exportTrace(): Promise<void> {
		if (!this.trace || this.exportOperation) { return; }
		const revision = this.revision;
		const sessionId = this.sessionId;
		const operation = {};
		this.exportOperation = operation;
		try {
			const capture = this.trace;
			const payloads: Record<string, unknown> = { ...capture.diagnostics?.payloads };
			let incomplete = false;
			for (const record of capture.diagnostics?.events ?? []) {
				const payload = diagnosticPayload(record);
				if (!payload) { continue; }
				if (payload.status !== 'saved') { incomplete = true; continue; }
				if (Object.hasOwn(payloads, payload.payloadId)) { continue; }
				if (!sessionId || !capture.diagnostics?.captureId) { incomplete = true; continue; }
				try { payloads[payload.payloadId] = await this.chat.readTracePayload(sessionId, capture.diagnostics.captureId, payload.payloadId); }
				catch { incomplete = true; }
				if (revision !== this.revision || this.isDisposed) { return; }
			}
			let graph = capture.graph ?? (sessionId ? await this.chat.readTraceGraph(sessionId) : undefined);
			if (revision !== this.revision || this.isDisposed) { return; }
			if (graph && sessionId) { graph = graphForCapture(capture, graph); }
			const artifact = { ...capture, graph, diagnostics: capture.diagnostics && { ...capture.diagnostics, payloads, recordingStatus: incomplete ? 'incomplete' : capture.diagnostics.recordingStatus } };
			const serialized = JSON.stringify(artifact, null, 2);
			const blob = new Blob([serialized], { type: 'application/json' });
			if (blob.size > 64 * 1024 * 1024) { throw new Error(localize('agentTrace.fileSize', 'Trace files must be smaller than 64 MiB.')); }
			triggerDownload(blob, 'session.agent-trace.json', this.domNode.ownerDocument);
		} catch (error) { if (revision === this.revision && !this.isDisposed) { this.statusDomNode.textContent = localize('agentTrace.failed', 'Could not load trace: {0}', String(error)); } }
		finally {
			// An older export must not unlock a replacement input's operation.
			if (this.exportOperation === operation) {
				this.exportOperation = undefined;
			}
		}
	}

	public getAccessibleContent(): string {
		const lines: string[] = [];
		const visit = (nodes: readonly import('../../../../base/browser/ui/tree/objectTreeModel.js').ObjectTreeNode<TraceEntry>[]): void => {
			for (const node of nodes) {
				if (!node.visible) { continue; }
				lines.push(node.element.record ? eventLabel(node.element.record) : node.element.label);
				visit(node.children);
			}
		};
		visit(this.tree.model.rootNodes);
		const selected = this.selected && this.viewModel.entries.get(this.selected);
		return `${this.emptyTree.hidden ? '' : this.emptyTree.textContent}\n${this.statusDomNode.textContent}\n${this.locationDomNode.textContent}\n${this.summaryDomNode.textContent}\n${lines.join('\n')}\n${this.relationList.items.map(item => item.label).join('\n')}\n${this.relationWarning.textContent}\n${this.detailText}\n${selected && selected.record ? JSON.stringify(selected.record, null, 2) : ''}`;
	}
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.isShown = visible;
		if (visible) { this.requestRefresh(); }
		else {
			this.revision++;
			this.exportOperation = undefined;
			this.refreshScheduler.cancel();
			this.diagnosticPoll.cancel();
			this.releaseSubscriptions();
			this.loading = false;
			this.progress.element.hidden = true;
			this.dirty = false;
			if (this.trace && this.sessionId) { this.statusDomNode.textContent = localize('agentTrace.paused', 'Paused · show the editor to follow new events'); }
		}
	}
	public override layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.domNode.style.width = `${dimension.width}px`; this.domNode.style.height = `${dimension.height}px`;
		this.configureSplit(dimension.width < 640);
		const height = Math.max(0, dimension.height - 64 - (this.locationDomNode.hidden ? 0 : 24));
		this.split.value!.layout(dimension.width < 640 ? height : dimension.width, dimension.width < 640 ? dimension.width : height);
	}
	public override focus(): void { if (this.selected) { this.tree.domFocus(); } else { this.filter.focus(); } }
	public override getControl(): IEditorControl | undefined { return undefined; }
}


/** The server graph may advance during payload reads; export only identities in the frozen capture.
 * Missing causal witnesses remain omissions rather than borrowing later diagnostic responses. */
function graphForCapture(capture: AgentTrace, graph: AgentTraceGraph): AgentTraceGraph {
	const threads = new Map(capture.threads.map(thread => [thread.threadId, thread]));
	const events = new Map<string, { readonly threadId: string; readonly turnId: unknown; }>(capture.threads.flatMap(thread => thread.events.map(record => [`${thread.threadId}:${record.sequence}`, { threadId: thread.threadId, turnId: record.event.turnId }] as const)));
	const diagnostics = new Map((capture.diagnostics?.events ?? []).map(record => [`diagnostic:${record.sequence}`, record]));
	const completed = new Set([...diagnostics.values()].filter(record => record.event.type === 'modelAttemptCompleted').map(record => JSON.stringify([record.threadId, record.turnId, record.event.attemptId])));
	const nodes = Object.fromEntries(Object.entries(graph.nodes).filter(([, node]) => {
		if (node.eventKey === null) { return node.kind === 'thread' && threads.has(node.threadId); }
		// Model attempts use diagnostic records; other graph nodes use durable events.
		// The external key alone can collide with a Thread literally named diagnostic.
		const record = node.kind === 'modelAttempt' ? diagnostics.get(node.eventKey) : events.get(node.eventKey);
		return !!record && record.threadId === node.threadId && (node.turnId === null || record.turnId === node.turnId);
	}));
	// A Code Mode cell points at its parent call; its nested call supplies the cell's evidence.
	const cells = new Set(graph.edges.filter(edge => edge.kind === 'nestedTool' && nodes[edge.to]).map(edge => edge.from));
	for (const node of Object.values(nodes)) {
		if (node.kind === 'codeCell' && !cells.has(node.id)) { delete nodes[node.id]; }
	}
	const edges = graph.edges.filter(edge => {
		const from = nodes[edge.from];
		const to = nodes[edge.to];
		if (!from || !to) { return false; }
		if (edge.kind === 'requestsTool') {
			const attempt = diagnostics.get(from.eventKey ?? '');
			return !!attempt && completed.has(JSON.stringify([attempt.threadId, attempt.turnId, attempt.event.attemptId]));
		}
		if (edge.kind === 'delegates') {
			return !!threads.get(from.threadId)?.events.some(record => record.event.type === 'delegationStarted' && record.event.childThreadId === to.threadId);
		}
		return true;
	});
	const omitted = Object.keys(graph.nodes).length - Object.keys(nodes).length + graph.edges.length - edges.length;
	const warnings = omitted ? [...graph.warnings, localize('agentTrace.graphScope', '{0} relationship entries excluded: their saved events or causal evidence are outside this capture.', omitted)] : graph.warnings;
	return { ...graph, nodes, edges, warnings };
}
