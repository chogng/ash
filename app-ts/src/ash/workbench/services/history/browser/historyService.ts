import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { Range } from '../../../../editor/common/core/range.js';
import { TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { EditorPaneSelectionChangeReason, isEditorPaneWithSelection } from '../../../common/editor.js';
import type { EditorPartChangeEvent } from '../../editor/common/editorState.js';
import { GoFilter, type IHistoryService } from '../common/history.js';

interface HistoryEntry {
	readonly editorId: string;
	readonly selection: Range | undefined;
	readonly fromActivation: boolean;
}

interface HistoryTimeline {
	readonly entries: HistoryEntry[];
	index: number;
}

/** Owns editor and location history and its command availability. */
export class HistoryService extends Disposable implements IHistoryService {
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

	constructor(
		@IEditorPart private readonly editorPart: IEditorPart,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
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
		this.recordActiveEditor();
		this.listenToActivePane();
	}

	public async goBack(filter = GoFilter.NONE): Promise<void> {
		this.navigate(filter, -1);
	}

	public async goForward(filter = GoFilter.NONE): Promise<void> {
		this.navigate(filter, 1);
	}

	private onEditorsChanged(event: EditorPartChangeEvent): void {
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
		if (this.isNavigating) return;
		const editorId = this.editorPart.getEditorState().activeEditor?.instanceId;
		if (!editorId) return;
		const timeline = this.timeline(GoFilter.NONE);
		if (timeline.entries[timeline.index]?.editorId === editorId) return;
		const pane = this.editorPart.activePane;
		const selection = isEditorPaneWithSelection(pane) ? pane.getSelection() : undefined;
		this.append(timeline, { editorId, selection, fromActivation: true });
		this.updateContextKeys();
	}

	private recordSelection(reason: EditorPaneSelectionChangeReason): void {
		if (this.isNavigating) return;
		const pane = this.editorPart.activePane;
		if (!isEditorPaneWithSelection(pane)) return;
		const editorId = this.editorPart.getEditorState().activeEditor?.instanceId;
		const selection = pane.getSelection();
		if (!editorId || !selection) return;
		const all = this.timeline(GoFilter.NONE);
		const previous = all.entries[all.index];
		const entry: HistoryEntry = { editorId, selection, fromActivation: false };
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
		const index = direction === -1 && filter !== GoFilter.NONE && current && !this.matchesActiveLocation(current)
			? timeline.index
			: timeline.index + direction;
		if (index < 0 || index >= timeline.entries.length) return;
		const entry = timeline.entries[index]!;
		const target = this.editorPart.groups.flatMap(group => group.editors).find(editor => editor.instanceId === entry.editorId);
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

	private matchesActiveLocation(entry: HistoryEntry): boolean {
		if (entry.editorId !== this.editorPart.getEditorState().activeEditor?.instanceId) return false;
		const pane = this.editorPart.activePane;
		const selection = isEditorPaneWithSelection(pane) ? pane.getSelection() : undefined;
		return !entry.selection || !!selection && entry.selection.startLineNumber === selection.startLineNumber;
	}

	private pruneClosedEditors(): void {
		const openIds = new Set(this.editorPart.groups.flatMap(group => group.editors.map(editor => editor.instanceId)));
		for (const timeline of this.timelines.values()) {
			for (let index = timeline.entries.length - 1; index >= 0; index -= 1) {
				if (openIds.has(timeline.entries[index]!.editorId)) continue;
				timeline.entries.splice(index, 1);
				if (index <= timeline.index) timeline.index -= 1;
			}
		}
	}

	private timeline(filter: GoFilter): HistoryTimeline {
		return this.timelines.get(filter)!;
	}

	private updateContextKeys(): void {
		const all = this.timeline(GoFilter.NONE);
		const edits = this.timeline(GoFilter.EDITS);
		const navigation = this.timeline(GoFilter.NAVIGATION);
		this.canNavigateBack.set(all.index > 0);
		this.canNavigateForward.set(all.index >= 0 && all.index < all.entries.length - 1);
		this.canNavigateBackInEdits.set(edits.index > 0 || edits.index >= 0 && !this.matchesActiveLocation(edits.entries[edits.index]!));
		this.canNavigateForwardInEdits.set(edits.index >= 0 && edits.index < edits.entries.length - 1);
		this.canNavigateBackInNavigation.set(navigation.index > 0 || navigation.index >= 0 && !this.matchesActiveLocation(navigation.entries[navigation.index]!));
		this.canNavigateForwardInNavigation.set(navigation.index >= 0 && navigation.index < navigation.entries.length - 1);
	}
}
