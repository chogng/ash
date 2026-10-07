import './media/timelinePane.css';
import { h } from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { extUri, basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITimelineService, type Timeline, type TimelineItem } from '../common/timeline.js';

export const TimelineFocusedContext = new RawContextKey<boolean>('timelineFocused', false);

interface TimelineRow {
	readonly id: string;
	readonly source: string;
	readonly item?: TimelineItem;
}

/** Owns requests for the selected file and merges provider pages into one accessible tree. */
export class TimelinePane extends ViewPane {
	private readonly tree: WorkbenchObjectTree<TimelineRow>;
	private readonly messageDomNode: HTMLDivElement;
	private readonly resourceDomNode: HTMLDivElement;
	private readonly rows = this._register(new DisposableStore());
	private readonly pending = this._register(new DisposableMap<string, DisposableStore>());
	private readonly timelines = new Map<string, Timeline>();
	private readonly excludedSources = new Set<string>();
	private readonly toolbar: WorkbenchToolBar;
	private uri: URI | undefined;
	private pinned = false;
	private generation = 0;
	private failed = false;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@ITimelineService private readonly timeline: ITimelineService,
		@IEditorService private readonly editors: IEditorService,
		@IFileService private readonly files: IFileService,
		@ICommandService private readonly commands: ICommandService,
		@IContextKeyService context: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IHoverService private readonly hover: IHoverService,
		@IContextMenuService menus: IContextMenuService,
		@ILogService private readonly log: ILogService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super(container, { ...options, headerActionsVisibility: 'whenExpanded' });
		this.restoreSources();
		this.contentElement.classList.add('ash-timeline');
		this.resourceDomNode = h(container.ownerDocument, 'div');
		this.resourceDomNode.className = 'ash-timeline-resource';
		this.messageDomNode = h(container.ownerDocument, 'div');
		this.messageDomNode.className = 'ash-timeline-message';
		this.messageDomNode.setAttribute('role', 'status');
		this.messageDomNode.tabIndex = 0;
		this.contentElement.append(this.resourceDomNode, this.messageDomNode);
		this._register(hover.setupDelayedHover(this.resourceDomNode, () => ({ content: this.uri?.toString() ?? '' })));
		this.tree = this._register(new WorkbenchObjectTree<TimelineRow>(this.contentElement, {
			configurationService: configuration,
			modelOptions: { identityProvider: { getId: row => row.id } },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: row => row.item?.label ?? localize('timeline.loadMore', 'Load More') },
			onWillRender: () => this.rows.clear(),
			renderElement: row => this.renderRow(row),
		}));
		this.tree.element.classList.add('ash-timeline-tree');
		TimelineFocusedContext.bindTo(this._register(context.createScoped(this.contentElement))).set(true);
		this.toolbar = this._register(new WorkbenchToolBar(this.headerActionsElement, menus, { ariaLabel: localize('timeline.actions', 'Timeline Actions') }));
		this._register(this.tree.onDidOpen(({ element, browserEvent }) => {
			if ('key' in browserEvent && browserEvent.key !== 'Enter' && browserEvent.key !== ' ') return;
			if (!element.item) { void this.load(element.source, true); return; }
			const command = element.item.command;
			if (command) void this.commands.executeCommand(command.id, ...(command.arguments ?? [])).catch(error => this.log.error('timeline', 'Could not open timeline entry', error));
		}));
		this._register(this.onDidChangeBodyVisibility(() => this.refresh()));
		this._register(editors.onDidActiveEditorChange(() => {
			if (this.pinned) return;
			const uri = this.activeUri();
			if (!extUri.isEqual(uri, this.uri)) this.refresh();
		}));
		this._register(timeline.onDidChangeProviders(() => { this.updateActions(); this.refresh(); }));
		this._register(timeline.onDidChangeTimeline(event => {
			if (!event.uri || extUri.isEqual(event.uri, this.uri)) this.refresh();
		}));
		this._register(timeline.onDidChangeUri(uri => { this.uri = uri; this.pinned = true; this.updateActions(); this.refresh(); }));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.Timeline)) this.updateAriaLabel();
			if (event.affectsConfiguration('timeline.pageSize')) this.refresh();
		}));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope !== StorageScope.PROFILE || event.key !== 'timeline.excludeSources') return;
			this.restoreSources();
			this.updateActions();
			this.refresh();
		}));
		this._register(toDisposable(() => this.timelines.clear()));
		this.updateActions();
		this.updateAriaLabel();
		this.render();
	}

	public override focus(): void {
		if (this.tree.element.hidden) this.messageDomNode.focus();
		else this.tree.domFocus();
	}

	public refresh(): void {
		this.generation++;
		this.pending.clearAndDisposeAll();
		this.timelines.clear();
		this.failed = false;
		if (!this.pinned) this.uri = this.activeUri();
		if (this.isBodyVisible() && this.uri) {
			for (const source of this.timeline.getSources()) {
				if (!this.excludedSources.has(source.id)) void this.load(source.id, false);
			}
		}
		this.render();
	}

	public getAccessibleContent(): string {
		const entries = this.items().map(({ item }) => [item!.label, item!.description].filter(Boolean).join(', '));
		return [localize('timeline.title', 'Timeline'), this.uri ? basename(this.uri) : '', entries.length ? entries.join('\n') : this.messageDomNode.textContent].filter(Boolean).join('\n');
	}

	private activeUri(): URI | undefined {
		const uri = EditorResourceAccessor.getOriginalUri(this.editors.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
		// Product pages have internal URIs but do not represent files with a history.
		return uri && this.files.hasProvider(uri) ? uri : undefined;
	}

	private async load(source: string, append: boolean): Promise<void> {
		const uri = this.uri;
		if (!uri || this.pending.has(source) || !this.isBodyVisible()) return;
		const generation = this.generation;
		const lifetime = new DisposableStore();
		const token = new CancellationTokenSource();
		lifetime.add(toDisposable(() => token.dispose(true)));
		this.pending.set(source, lifetime);
		this.render();
		try {
			const previous = this.timelines.get(source);
			const pageSize = this.configuration.getValue<number | null>('timeline.pageSize');
			const request = this.timeline.getTimeline(source, uri, { cursor: append ? previous?.paging?.cursor : undefined, limit: pageSize ?? Math.max(1, Math.ceil(this.contentElement.clientHeight / 22)), cacheResults: true, resetCache: !append }, token);
			const result = await request?.result;
			if (this.isDisposed || generation !== this.generation || this.pending.get(source) !== lifetime || token.token.isCancellationRequested) return;
			if (result) {
				const items = new Map((append ? previous?.items ?? [] : []).map(item => [item.handle, item]));
				for (const item of result.items) items.set(item.handle, item);
				this.timelines.set(source, { ...result, items: [...items.values()] });
			}
		} catch (error) {
			if (generation === this.generation && !token.token.isCancellationRequested && !isCancellationError(error)) {
				this.failed = true;
				this.log.error('timeline', 'Could not load timeline entries', error);
			}
		} finally {
			if (this.pending.get(source) === lifetime) {
				this.pending.deleteAndDispose(source);
				this.render();
			}
		}
	}

	private items(): TimelineRow[] {
		return [...this.timelines.values()].flatMap(timeline => timeline.items.map(item => ({ id: `item:${item.source.length}:${item.source}${item.handle}`, source: item.source, item }))).sort((a, b) => b.item.timestamp - a.item.timestamp || a.id.localeCompare(b.id));
	}

	private render(): void {
		const entries = this.items();
		const more = [...this.timelines].filter(([, timeline]) => timeline.paging?.cursor !== undefined).map(([source]) => ({ id: `more:${source}`, source }));
		const focus = this.tree.focus?.id;
		const selection = this.tree.selection.map(row => row.id);
		this.tree.setChildren([...entries, ...more].map(element => ({ element })));
		if (focus && this.tree.model.has(focus)) this.tree.setFocus(focus);
		this.tree.setSelection(selection.filter(id => this.tree.model.has(id)));
		this.tree.element.hidden = entries.length + more.length === 0;
		this.tree.element.setAttribute('aria-busy', String(this.pending.size > 0));
		this.messageDomNode.hidden = !this.tree.element.hidden;
		this.resourceDomNode.textContent = this.uri ? basename(this.uri) : '';
		if (this.pending.size > 0) this.messageDomNode.textContent = localize('timeline.loading', 'Loading timeline…');
		else if (!this.uri) this.messageDomNode.textContent = localize('timeline.noFile', 'Select a file to view its timeline.');
		else if (this.failed) this.messageDomNode.textContent = localize('timeline.failed', 'Could not load timeline entries.');
		else this.messageDomNode.textContent = localize('timeline.empty', 'No timeline information was provided.');
	}

	private renderRow(row: TimelineRow): HTMLElement {
		const content = h(this.contentElement.ownerDocument, 'span');
		content.className = 'ash-timeline-row';
		const label = h(content.ownerDocument, 'span');
		label.className = 'ash-timeline-label';
		label.textContent = row.item?.label ?? localize('timeline.loadMore', 'Load More');
		content.append(label);
		const description = h(content.ownerDocument, 'span');
		description.className = 'ash-timeline-description';
		description.textContent = row.item?.description ?? this.timeline.getSources().find(source => source.id === row.source)?.label ?? '';
		content.append(description);
		this.rows.add(this.hover.setupDelayedHover(content, { content: row.item?.tooltip ?? [label.textContent, description.textContent].join(' — ') }));
		return content;
	}

	private updateAriaLabel(): void {
		const label = localize('timeline.title', 'Timeline');
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Timeline);
		this.tree.element.setAttribute('aria-label', hint ? `${label}. ${hint}` : label);
		this.messageDomNode.setAttribute('aria-label', hint ? `${label}. ${hint}` : label);
	}

	private restoreSources(): void {
		this.excludedSources.clear();
		let value: unknown;
		try { value = JSON.parse(this.storage.get('timeline.excludeSources', StorageScope.PROFILE, '[]')); } catch { return; }
		if (!Array.isArray(value) || !value.every(source => typeof source === 'string')) return;
		for (const source of value) this.excludedSources.add(source);
	}

	private updateActions(): void {
		const refresh = localize('timeline.refresh', 'Refresh');
		const pin = localize('timeline.pin', 'Pin Current File');
		this.toolbar.setActions([{ id: 'timeline.refresh', label: refresh, tooltip: refresh, icon: Lxicon.refresh, enabled: true, run: () => this.refresh() }], [
			{ id: 'timeline.pin', label: pin, tooltip: pin, enabled: true, checked: this.pinned, run: () => { this.pinned = !this.pinned; this.updateActions(); this.refresh(); } },
			...this.timeline.getSources().map(source => ({
				id: `timeline.source.${source.id}`, label: source.label, tooltip: source.label, enabled: true, checked: !this.excludedSources.has(source.id), run: () => {
					const excluded = new Set(this.excludedSources);
					if (excluded.has(source.id)) excluded.delete(source.id);
					else excluded.add(source.id);
					this.storage.store('timeline.excludeSources', JSON.stringify([...excluded]), StorageScope.PROFILE, StorageTarget.USER);
				}
			})),
		]);
	}
}
