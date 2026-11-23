import { TaskQueue } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Schemas } from '../../../../base/common/network.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { Range } from '../../../../editor/common/core/range.js';
import { TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { EditorPaneSelectionChangeReason, isEditorPaneWithSelection } from '../../../common/editor.js';
import type { EditorIdentifier, EditorPartChangeEvent } from '../../editor/common/editorState.js';
import { GoFilter, type IHistoryService } from '../common/history.js';
import type { IExpression } from '../../../../base/common/glob.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ResourceGlobMatcher } from '../../../common/resources.js';
import '../../filesConfiguration/common/filesConfigurationService.js';
import { URI } from '../../../../base/common/uri.js';
import { extUri } from '../../../../base/common/resources.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorInputSerializers } from '../../editor/common/editorInputSerializer.js';

interface HistoryEntry {
	readonly editorId: string;
	readonly selection: Range | undefined;
	readonly fromActivation: boolean;
}

interface HistoryTimeline {
	readonly entries: HistoryEntry[];
	index: number;
}

interface ClosedEditor {
	readonly resource: URI;
	readonly editorId: string | undefined;
	readonly restore: () => IResourceEditorInput;
	readonly preferredEditorId: string;
	readonly index: number;
}

/** Owns editor and location history and its command availability. */
export class HistoryService extends Disposable implements IHistoryService {
	private readonly recentlyOpened = new Map<string, IResourceEditorInput>();
	private readonly recentlyClosed: ClosedEditor[] = [];
	private readonly reopenQueue = new TaskQueue();
	private reopening: ClosedEditor | undefined;
	private readonly timelines = new Map<GoFilter, HistoryTimeline>([
		[GoFilter.NONE, { entries: [], index: -1 }],
		[GoFilter.EDITS, { entries: [], index: -1 }],
		[GoFilter.NAVIGATION, { entries: [], index: -1 }],
	]);
	private readonly selectionListener = this._register(new MutableDisposable<IDisposable>());
	private readonly canNavigateBack: IContextKey<boolean>;
	private readonly canNavigateForward: IContextKey<boolean>;
	private readonly canNavigateBackInEdits: IContextKey<boolean>;
	private readonly canNavigateForwardInEdits: IContextKey<boolean>;
	private readonly canNavigateBackInNavigation: IContextKey<boolean>;
	private readonly canNavigateForwardInNavigation: IContextKey<boolean>;
	private isNavigating = false;
	private readonly resourceExcludeMatcher: ResourceGlobMatcher;

	constructor(
		@IEditorPart private readonly editorPart: IEditorPart,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService configuration: IConfigurationService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		this.resourceExcludeMatcher = this._register(new ResourceGlobMatcher(() => ({ ...configuration.getValue<IExpression>('files.exclude'), ...configuration.getValue<IExpression>('search.exclude') }), event => event.affectsConfiguration('files.exclude') || event.affectsConfiguration('search.exclude'), workspace, configuration));
		this.restoreHistory();
		this._register(toDisposable(() => {
			this.reopenQueue.clearPending();
			this.recentlyClosed.length = 0;
		}));
		this.canNavigateBack = contextKeyService.createKey('canNavigateBack', false);
		this.canNavigateForward = contextKeyService.createKey('canNavigateForward', false);
		this.canNavigateBackInEdits = contextKeyService.createKey('canNavigateBackInEditLocations', false);
		this.canNavigateForwardInEdits = contextKeyService.createKey('canNavigateForwardInEditLocations', false);
		this.canNavigateBackInNavigation = contextKeyService.createKey('canNavigateBackInNavigationLocations', false);
		this.canNavigateForwardInNavigation = contextKeyService.createKey('canNavigateForwardInNavigationLocations', false);
		this._register(toDisposable(() => {
			for (const key of [this.canNavigateBack, this.canNavigateForward, this.canNavigateBackInEdits, this.canNavigateForwardInEdits, this.canNavigateBackInNavigation, this.canNavigateForwardInNavigation]) {
				key.reset();
			}
		}));
		this._register(editorPart.onDidChangeEditors(event => this.onEditorsChanged(event)));
		this._register(this.resourceExcludeMatcher.onExpressionChange(() => {
			this.pruneClosedEditors();
			this.updateContextKeys();
		}));
		this.recordActiveEditor();
		this.listenToActivePane();
		this.updateContextKeys();
	}

	public getHistory(): readonly IResourceEditorInput[] {
		return [...this.recentlyOpened.values()].reverse().filter(input => !this.resourceExcludeMatcher.matches(input.resource));
	}

	public remove(resource: URI): void {
		if (this.recentlyOpened.delete(extUri.getComparisonKey(resource))) this.saveHistory();
		if (this.reopening && extUri.isEqual(this.reopening.resource, resource)) {
			this.reopening = undefined;
		}
		for (let index = this.recentlyClosed.length - 1; index >= 0; index--) {
			if (extUri.isEqual(this.recentlyClosed[index].resource, resource)) this.recentlyClosed.splice(index, 1);
		}
	}

	private saveHistory(): void {
		this.storage.store('history.recentlyOpened', JSON.stringify([...this.recentlyOpened.values()].map(input => input.resource.toString())), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private restoreHistory(): void {
		try {
			const stored: unknown = JSON.parse(this.storage.get('history.recentlyOpened', StorageScope.WORKSPACE, '[]'));
			if (!Array.isArray(stored)) return;
			for (const value of stored.slice(-100)) {
				if (typeof value !== 'string') continue;
				try {
					const resource = URI.parse(value);
					if (resource.scheme && resource.path) this.recentlyOpened.set(extUri.getComparisonKey(resource), { resource });
				} catch { /* A malformed stored entry must not prevent restoring other resources. */ }
			}
		} catch { /* An older or damaged history value starts an empty resource history. */ }
	}

	public async goBack(filter = GoFilter.NONE): Promise<void> {
		this.navigate(filter, -1);
	}

	public async goForward(filter = GoFilter.NONE): Promise<void> {
		this.navigate(filter, 1);
	}

	public async reopenLastClosedEditor(): Promise<void> {
		await this.reopenQueue.scheduleSkipIfCleared(() => this.reopenClosedEntry());
	}

	private async reopenClosedEntry(): Promise<void> {
		while (!this.isDisposed && this.recentlyClosed.length > 0) {
			const closed = this.recentlyClosed.shift()!;
			if (this.editorPart.activeGroup.inputs.some(input => input.editorId === closed.editorId && extUri.isEqual(input.resource, closed.resource))) {
				continue;
			}
			this.reopening = closed;
			try {
				const input = closed.restore();
				const choices = this.editorPart.getEditorPaneChoices(input, { includeExplicit: true });
				const preferredEditorId = choices.find(choice => choice.id === closed.preferredEditorId)?.id;
				const pane = await this.editorPart.openEditor(input, { preferredEditorId, pinned: true, index: closed.index, ignoreError: true });
				if (!this.isDisposed && this.reopening === closed) {
					pane.focus();
				}
				return;
			} catch (error) {
				if (isCancellationError(error)) {
					if (!this.isDisposed && this.reopening === closed) {
						this.recentlyClosed.unshift(closed);
					}
					return;
				}
				// Missing resources and unavailable providers cannot block older closed editors.
			} finally {
				this.reopening = undefined;
			}
		}
	}

	private recordClosedEditor(input: IResourceEditorInput, paneId: string, index: number): void {
		if (input.resource.scheme === Schemas.untitled) {
			return;
		}
		let restore: () => IResourceEditorInput;
		try {
			if (input instanceof EditorInput) {
				// Live inputs can be disposed after the close event. Retain their restoration data instead.
				const snapshot = EditorInputSerializers.serialize(input);
				restore = () => EditorInputSerializers.deserialize(snapshot);
			} else {
				const resourceInput = input.toUntyped?.() ?? input;
				restore = () => resourceInput;
			}
		} catch {
			// An editor without restorable data must not interrupt its close.
			return;
		}
		const duplicate = this.recentlyClosed.findIndex(closed => closed.preferredEditorId === paneId && closed.editorId === input.editorId && extUri.isEqual(closed.resource, input.resource));
		if (duplicate >= 0) {
			this.recentlyClosed.splice(duplicate, 1);
		}
		this.recentlyClosed.unshift({ resource: input.resource, editorId: input.editorId, restore, preferredEditorId: paneId, index });
		if (this.recentlyClosed.length > 20) {
			this.recentlyClosed.length = 20;
		}
	}

	private onEditorsChanged(event: EditorPartChangeEvent): void {
		if (!this.isDisposed && event.kind === 'groupChanged' && event.event.kind === 'editorClosed' && event.event.reason === 'close') {
			const editor = event.event.editor;
			this.recordClosedEditor(editor.input, editor.paneId, editor.index);
		} else if (!this.isDisposed && event.kind === 'modalEditorChanged' && event.closedEditor) {
			this.recordClosedEditor(event.closedEditor.input, event.closedEditor.paneId, 0);
		}
		if (event.kind === 'groupRemoved' || event.kind === 'groupChanged' && event.event.kind === 'editorClosed') {
			this.pruneClosedEditors();
		}
		if (event.kind === 'activeGroupChanged' || event.kind === 'groupChanged' && event.event.kind === 'activeEditorChanged') {
			this.recordActiveEditor();
			this.listenToActivePane();
		}
		this.updateContextKeys();
	}

	private listenToActivePane(): void {
		const pane = this.editorPart.activePane;
		this.selectionListener.value = isEditorPaneWithSelection(pane)
			? pane.onDidChangeSelection(reason => this.recordSelection(reason))
			: undefined;
	}

	private recordActiveEditor(): void {
		const active = this.editorPart.activeInput;
		if (active && !this.resourceExcludeMatcher.matches(active.resource)) {
			const key = extUri.getComparisonKey(active.resource);
			this.recentlyOpened.delete(key);
			this.recentlyOpened.set(key, { resource: active.resource });
			if (this.recentlyOpened.size > 100) this.recentlyOpened.delete(this.recentlyOpened.keys().next().value!);
			this.saveHistory();
		}
		if (this.isNavigating) return;
		const editor = this.editorPart.activeGroup.activeEditor;
		if (!editor || this.resourceExcludeMatcher.matches(editor.input.resource)) return;
		const editorId = editor.instanceId;
		const timeline = this.timeline(GoFilter.NONE);
		if (timeline.entries[timeline.index]?.editorId === editorId) return;
		const pane = this.editorPart.activePane;
		const selection = isEditorPaneWithSelection(pane) ? pane.getSelection() : undefined;
		this.append(timeline, { editorId, selection, fromActivation: true });
	}

	private recordSelection(reason: EditorPaneSelectionChangeReason): void {
		if (this.isNavigating) return;
		const pane = this.editorPart.activePane;
		if (!isEditorPaneWithSelection(pane)) return;
		const editor = this.editorPart.activeGroup.activeEditor;
		if (!editor || this.resourceExcludeMatcher.matches(editor.input.resource)) return;
		const selection = pane.getSelection();
		if (!selection) return;
		const all = this.timeline(GoFilter.NONE);
		const previous = all.entries[all.index];
		const entry: HistoryEntry = { editorId: editor.instanceId, selection, fromActivation: false };
		if (!previous) {
			this.append(all, entry);
			this.updateContextKeys();
			return;
		}
		if (reason === EditorPaneSelectionChangeReason.NAVIGATION || reason === EditorPaneSelectionChangeReason.JUMP) {
			const navigation = this.timeline(GoFilter.NAVIGATION);
			const source = previous.fromActivation ? all.entries[all.index - 1] : previous;
			if (source) this.appendIfDistinct(navigation, source, reason);
			this.appendIfDistinct(navigation, entry, reason);
		}
		if (reason === EditorPaneSelectionChangeReason.EDIT) {
			this.appendIfDistinct(this.timeline(GoFilter.EDITS), entry, reason);
		}
		if (
			previous.fromActivation && reason !== EditorPaneSelectionChangeReason.USER ||
			reason === EditorPaneSelectionChangeReason.PROGRAMMATIC ||
			!this.isDistinct(previous, entry, reason)
		) {
			if (reason !== EditorPaneSelectionChangeReason.PROGRAMMATIC) all.entries.splice(all.index + 1);
			all.entries[all.index] = entry;
		} else {
			this.append(all, entry);
		}
		this.updateContextKeys();
	}

	private appendIfDistinct(timeline: HistoryTimeline, entry: HistoryEntry, reason: EditorPaneSelectionChangeReason): void {
		const editor = this.findEditor(entry.editorId);
		if (!editor || this.resourceExcludeMatcher.matches(editor.input.resource)) return;
		const current = timeline.entries[timeline.index];
		if (current && !this.isDistinct(current, entry, reason)) {
			timeline.entries.splice(timeline.index + 1);
			timeline.entries[timeline.index] = entry;
			return;
		}
		this.append(timeline, entry);
	}

	private isDistinct(previous: HistoryEntry, next: HistoryEntry, reason: EditorPaneSelectionChangeReason): boolean {
		if (previous.editorId !== next.editorId) return true;
		if (!previous.selection || !next.selection) return true;
		if (reason === EditorPaneSelectionChangeReason.NAVIGATION || reason === EditorPaneSelectionChangeReason.JUMP) {
			return previous.selection.startLineNumber !== next.selection.startLineNumber;
		}
		return Math.abs(previous.selection.startLineNumber - next.selection.startLineNumber) >= 10;
	}

	private append(timeline: HistoryTimeline, entry: HistoryEntry): void {
		timeline.entries.splice(timeline.index + 1);
		timeline.entries.push(entry);
		if (timeline.entries.length > 50) timeline.entries.shift();
		timeline.index = timeline.entries.length - 1;
	}

	private navigate(filter: GoFilter, direction: -1 | 1): void {
		this.pruneClosedEditors();
		this.updateContextKeys();
		const timeline = this.timeline(filter);
		const current = timeline.entries[timeline.index];
		const active = this.editorPart.activeGroup.activeEditor;
		const activeExcluded = active && this.resourceExcludeMatcher.matches(active.input.resource);
		const index = direction === -1 && (filter !== GoFilter.NONE || activeExcluded) && current && !this.matchesActiveLocation(current, active?.instanceId)
			? timeline.index
			: timeline.index + direction;
		if (index < 0 || index >= timeline.entries.length) return;
		const entry = timeline.entries[index]!;
		const target = this.findEditor(entry.editorId);
		if (!target) return;
		timeline.index = index;
		this.isNavigating = true;
		try {
			const pane = this.editorPart.activateEditorIdentifier(target);
			if (pane && entry.selection && isEditorPaneWithSelection(pane)) pane.restoreSelection(entry.selection, TextEditorSelectionSource.PROGRAMMATIC);
			pane?.focus();
			if (filter !== GoFilter.NONE) this.appendIfDistinct(this.timeline(GoFilter.NONE), entry, EditorPaneSelectionChangeReason.NAVIGATION);
		} finally {
			this.isNavigating = false;
			this.updateContextKeys();
		}
	}

	private matchesActiveLocation(entry: HistoryEntry, activeEditorId: string | undefined): boolean {
		if (entry.editorId !== activeEditorId) return false;
		const pane = this.editorPart.activePane;
		const selection = isEditorPaneWithSelection(pane) ? pane.getSelection() : undefined;
		return !entry.selection || !!selection && entry.selection.startLineNumber === selection.startLineNumber;
	}

	private pruneClosedEditors(): void {
		const openIds = new Set<string>();
		for (const group of this.editorPart.groups) {
			for (const editor of group.editors) {
				if (!this.resourceExcludeMatcher.matches(editor.input.resource)) {
					openIds.add(editor.instanceId);
				}
			}
		}
		for (const timeline of this.timelines.values()) {
			for (let index = timeline.entries.length - 1; index >= 0; index -= 1) {
				if (openIds.has(timeline.entries[index]!.editorId)) continue;
				timeline.entries.splice(index, 1);
				if (index <= timeline.index) timeline.index -= 1;
			}
		}
	}

	private findEditor(editorId: string): EditorIdentifier | undefined {
		for (const group of this.editorPart.groups) {
			const editor = group.getEditorIdentifier(editorId);
			if (editor) {
				return editor;
			}
		}
		return undefined;
	}

	private timeline(filter: GoFilter): HistoryTimeline {
		return this.timelines.get(filter)!;
	}

	private updateContextKeys(): void {
		const all = this.timeline(GoFilter.NONE);
		const edits = this.timeline(GoFilter.EDITS);
		const navigation = this.timeline(GoFilter.NAVIGATION);
		const active = this.editorPart.activeGroup.activeEditor;
		this.canNavigateBack.set(all.index > 0 || all.index >= 0 && !!active && this.resourceExcludeMatcher.matches(active.input.resource));
		this.canNavigateForward.set(all.index < all.entries.length - 1);
		this.canNavigateBackInEdits.set(edits.index > 0 || edits.index >= 0 && !this.matchesActiveLocation(edits.entries[edits.index]!, active?.instanceId));
		this.canNavigateForwardInEdits.set(edits.index >= 0 && edits.index < edits.entries.length - 1);
		this.canNavigateBackInNavigation.set(navigation.index > 0 || navigation.index >= 0 && !this.matchesActiveLocation(navigation.entries[navigation.index]!, active?.instanceId));
		this.canNavigateForwardInNavigation.set(navigation.index >= 0 && navigation.index < navigation.entries.length - 1);
	}
}
