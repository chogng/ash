import { h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { ObjectTree } from '../../../../../base/browser/ui/tree/objectTree.js';
import { TreeVisibility } from '../../../../../base/browser/ui/tree/tree.js';
import { IconLabel } from '../../../../../base/browser/ui/iconlabel/iconlabel.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { isRecord } from '../../../../../base/common/types.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { defaultButtonStyles, defaultListStyles, defaultFindWidgetStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { AgentTraceViewModel, eventLabel, type TraceEntry } from './agentTraceModel.js';
import { LogsViewMode } from './chatDebugTypes.js';

/** One widget owner for hierarchical and flat views of the same saved evidence. */
export class ChatDebugLogsView extends Disposable {
	readonly container: HTMLDivElement;
	readonly tree: ObjectTree<TraceEntry>;
	private model: AgentTraceViewModel | undefined;
	private readonly rowLabels = new Map<HTMLElement, IconLabel>();
	private mode = LogsViewMode.Tree;
	private readonly modes = new Map<LogsViewMode, Button>();
	private readonly groups = new Map<string, boolean>();
	private readonly groupButtons: Button[] = [];
	private readonly status: HTMLElement;

	constructor(parent: HTMLElement, @IClipboardService private readonly clipboard: IClipboardService) {
		super();
		const document = parent.ownerDocument;
		const toolbar = h(document, 'div', { className: 'ash-chat-debug-view-navigation ash-chat-debug-log-controls' });
		for (const [mode, label] of [[LogsViewMode.Tree, localize('chatDebug.treeView', 'Tree View')], [LogsViewMode.List, localize('chatDebug.listView', 'List View')]] as const) {
			const button = this._register(new Button(toolbar, { ...defaultButtonStyles, presentation: 'quiet', size: 'small', iconOnly: true, icon: mode === LogsViewMode.Tree ? Lxicon.folders : Lxicon.listUnordered, title: label, label, onClick: () => this.setMode(mode) }));
			button.checked = mode === this.mode; this.modes.set(mode, button);
		}
		for (const [collapsed, label] of [[false, localize('chatDebug.expandAll', 'Expand All')], [true, localize('chatDebug.collapseAll', 'Collapse All')]] as const) {
			this.groupButtons.push(this._register(new Button(toolbar, {
				...defaultButtonStyles, presentation: 'quiet', size: 'small', iconOnly: true, icon: collapsed ? Lxicon.collapseAll : Lxicon.unfold, title: label, label, onClick: () => {
					for (const entry of this.model?.entries.values() ?? []) {
						if (entry.kind !== 'event' && this.tree.model.has(entry.id)) {
							if (collapsed) { this.tree.collapse(entry.id); } else { this.tree.expand(entry.id); }
						}
					}
				}
			})));
		}
		this._register(new Button(toolbar, { ...defaultButtonStyles, presentation: 'quiet', size: 'small', iconOnly: true, icon: Lxicon.copy, title: localize('chatDebug.copyLogRow', 'Copy Selected Row'), label: localize('chatDebug.copyLogRow', 'Copy Selected Row'), onClick: () => { void this.copy(); } }));
		this.status = h(document, 'p', { className: 'ash-chat-debug-notice' }); this.status.setAttribute('aria-live', 'polite'); this.status.hidden = true;
		this.container = h(document, 'div', { className: 'ash-agent-trace-tree' });
		parent.append(toolbar, this.status, this.container);
		this.tree = this._register(new ObjectTree<TraceEntry>(this.container, {
			styles: defaultListStyles,
			findWidgetStyles: defaultFindWidgetStyles,
			ariaLabel: localize('agentTrace.timeline', 'Execution timeline'),
			scrolling: 'managed',
			getHeight: () => 22,
			indent: 12,
			indentGuides: 'always',
			expandOnlyOnTwistieClick: true,
			modelOptions: { identityProvider: { getId: entry => entry.id }, filter: { filter: entry => entry.kind === 'event' ? this.model!.matched.has(entry.id) : TreeVisibility.Recurse } },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: entry => entry.label },
			renderElement: entry => {
				const root = h(document, 'span', { className: `ash-agent-trace-row ash-agent-trace-${entry.kind}` });
				root.dataset.traceRow = entry.id;
				root.dataset.threadId = entry.threadId;
				if (entry.turnId) { root.dataset.turnId = entry.turnId; }
				if (entry.key) { root.dataset.key = entry.key; }
				if (entry.record) { root.dataset.eventId = entry.record.eventId; }
				const type = entry.record?.event.type;
				const label = new IconLabel(root, { label: entry.label, description: entry.description, icon: entry.kind === 'thread' ? Lxicon.chat : type?.startsWith('model') ? Lxicon.sparkle : isRecord(entry.record?.event.item) && String(entry.record.event.item.type).startsWith('tool') ? Lxicon.terminal : Lxicon.history, title: [entry.threadId, entry.turnId, entry.record?.eventId, entry.record && eventLabel(entry.record, entry.performance)].filter(Boolean).join(' · ') });
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
		this._register(toDisposable(() => { toolbar.remove(); this.status.remove(); this.container.remove(); }));
	}

	clear(): void {
		this.model = undefined; this.groups.clear();
		this.status.textContent = ''; this.status.hidden = true;
		this.tree.setChildren([]);
	}

	refreshList(model: AgentTraceViewModel, changed: boolean): void {
		this.model = model;
		if (changed) { this.tree.setChildren(this.mode === LogsViewMode.Tree ? model.roots : [...model.entries.values()].filter(entry => entry.kind === 'event').map(element => ({ element }))); }
		else { this.tree.model.refilter(); }
	}

	private setMode(mode: LogsViewMode): void {
		if (mode === this.mode || !this.model) { return; }
		const selected = this.tree.selection[0]?.id;
		const focused = this.tree.focus?.id;
		if (this.mode === LogsViewMode.Tree) {
			this.groups.clear();
			for (const entry of this.model.entries.values()) { if (entry.kind !== 'event') { this.groups.set(entry.id, this.tree.isCollapsed(entry.id) ?? false); } }
		}
		this.mode = mode;
		for (const [value, button] of this.modes) { button.checked = value === mode; }
		for (const button of this.groupButtons) { button.enabled = mode === LogsViewMode.Tree; }
		this.refreshList(this.model, true);
		if (mode === LogsViewMode.Tree) { for (const [id, collapsed] of this.groups) { if (this.tree.model.has(id)) { if (collapsed) { this.tree.collapse(id); } else { this.tree.expand(id); } } } }
		if (selected && this.tree.model.has(selected)) { this.tree.setSelection([selected]); this.tree.reveal(selected); }
		if (focused && this.tree.model.has(focused)) { this.tree.setFocus(focused); }
	}

	private async copy(): Promise<void> {
		this.status.hidden = false;
		const entry = this.tree.selection[0] ?? this.tree.focus;
		if (!entry) { this.status.textContent = localize('chatDebug.selectLogRow', 'Select a log row to copy.'); return; }
		const record = entry.record;
		const text = record ? `${new Date(record.recordedAt).toISOString()}\t${entry.threadId}\t${entry.turnId ?? ''}\t${eventLabel(record, entry.performance)}\n${JSON.stringify(record, null, 2)}` : `${entry.label}\t${entry.threadId}`;
		try { await this.clipboard.writeText(text); if (!this.isDisposed) { this.status.textContent = localize('chatDebug.rowCopied', 'Selected row copied.'); } }
		catch (error) { if (!this.isDisposed) { this.status.textContent = localize('chatDebug.copyFailed', 'Could not copy: {0}', String(error)); } }
	}
}
