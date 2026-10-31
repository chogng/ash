import { h } from '../../../../base/browser/dom.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { localize } from '../../../../nls.js';
import { VIEW_ID } from '../../files/common/files.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { createMultiDiffEditorInput, type MultiDiffEditorInput } from './multiDiffEditorInput.js';
import { IMultiDiffSourceResolverService } from './multiDiffSourceResolverService.js';
import type { MultiDiffEditorWidget } from '../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';

export interface MultiDiffEditorToolbarOptions {
	readonly container: HTMLElement;
	readonly input: MultiDiffEditorInput;
	readonly editor: MultiDiffEditorWidget;
}

/** Source owners contribute repository actions; the editor owns their accessible presentation. */
export class MultiDiffEditorToolbar extends Disposable {
	readonly domNode: HTMLDivElement;
	private readonly statusDomNode: HTMLDivElement;
	private busy = false;
	constructor(private readonly options: MultiDiffEditorToolbarOptions,
		@IMultiDiffSourceResolverService private readonly sourceResolvers: IMultiDiffSourceResolverService,
		@IHoverService hoverService: IHoverService,
		@IEditorService editorService: IEditorService,
		@IViewsService viewsService: IViewsService,
		@IContextMenuService contextMenuService: IContextMenuService,
	) {
		super();
		const document = options.container.ownerDocument;
		this.domNode = h(document, 'div'); this.domNode.className = 'stanza-multi-diff-editor-toolbar';
		const left = h(document, 'div'); left.className = 'stanza-multi-diff-editor-toolbar-left';
		const right = h(document, 'div'); right.className = 'stanza-multi-diff-editor-toolbar-right';
		this.statusDomNode = h(document, 'div'); this.statusDomNode.className = 'stanza-multi-diff-editor-toolbar-status';
		this.statusDomNode.setAttribute('role', 'status'); this.statusDomNode.setAttribute('aria-live', 'polite');
		this.domNode.append(left, this.statusDomNode, right); options.container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const sourceActions = this.sourceResolvers.sourceActions().map(action => this.wrap(action));
		if (options.input.source?.kind === 'external' && sourceActions.length) {
			const primary = new ToolbarAction('multiDiff.source', options.input.source.label, localize('multiDiff.selectSource', 'Select change source'), undefined, true, () => this.run(async () => {
				const resolved = await this.sourceResolvers.resolve(options.input.resource);
				if (resolved) await editorService.openEditor(createMultiDiffEditorInput(resolved.resource, resolved.resources, resolved.label, resolved.source), { pinned: true });
			}));
			const dropdown = new ToolbarAction('multiDiff.source.menu', localize('multiDiff.selectSource', 'Select change source'), localize('multiDiff.selectSource', 'Select change source'), Lxicon.chevronDown, true, () => { });
			const toolbar = this._register(new WorkbenchToolBar(left, contextMenuService, {
				ariaLabel: localize('multiDiff.changeSource', 'Multi-diff change source'),
				actionViewItemProvider: action => action.id === primary.id ? new DropdownWithPrimaryActionViewItem(primary, dropdown, sourceActions, contextMenuService) : undefined,
			}));
			toolbar.setActions([primary]); toolbar.element.classList.add('stanza-multi-diff-editor-source-toolbar');
		} else {
			const label = h(document, 'span'); label.className = 'ash-multi-diff-editor-source-label'; label.textContent = options.input.label; left.append(label);
			this._register(hoverService.setupDelayedHover(label, { content: options.input.label }));
		}
		const primary = this.sourceResolvers.primaryRepositoryAction(options.input);
		const repositoryActions = this.sourceResolvers.repositoryActions?.(options.input).map(action => this.wrap(action)) ?? [];
		const wrapped = primary ? this.wrap(primary) : undefined;
		const dropdown = new ToolbarAction('multiDiff.repository.menu', localize('multiDiff.repositoryActions', 'Multi-diff repository actions'), localize('multiDiff.repositoryActions', 'Multi-diff repository actions'), Lxicon.chevronDown, true, () => { });
		const toolbar = this._register(new WorkbenchToolBar(right, contextMenuService, {
			ariaLabel: localize('multiDiff.repositoryActions', 'Multi-diff repository actions'),
			actionViewItemProvider: action => wrapped && action.id === wrapped.id && repositoryActions.length ? new DropdownWithPrimaryActionViewItem(wrapped, dropdown, repositoryActions, contextMenuService) : undefined,
		}));
		const files = new ToolbarAction('multiDiff.files', localize('multiDiff.files', 'Files'), localize('multiDiff.openFiles', 'Open Files'), Lxicon.files, true, () => viewsService.focusView(VIEW_ID));
		toolbar.setActions(wrapped ? [wrapped, files] : [files], [
			{
				id: 'multiDiff.toggleCollapseAll',
				label: localize('multiDiff.collapseAll', 'Collapse All'),
				get tooltip() { return options.editor.allCollapsed ? localize('multiDiff.expandAllTooltip', 'Expand all diffs') : localize('multiDiff.collapseAllTooltip', 'Collapse all diffs'); },
				icon: Lxicon.fold,
				enabled: true,
				get checked() { return options.editor.allCollapsed; },
				run: () => options.editor.toggleCollapseAll(),
			},
		]);
		toolbar.element.classList.add('stanza-multi-diff-editor-repository-toolbar');
	}
	private wrap(action: IAction): IAction { return new ToolbarAction(action.id, action.label, action.tooltip, action.icon, action.enabled, () => this.run(() => Promise.resolve(action.run()))); }
	private async run(operation: () => Promise<unknown>): Promise<void> {
		if (this.busy || this.isDisposed) return;
		this.busy = true; this.domNode.classList.add('busy'); this.statusDomNode.textContent = localize('multiDiff.working', 'Working…');
		try { const result = await operation(); if (!this.isDisposed) this.statusDomNode.textContent = typeof result === 'string' ? result : ''; }
		catch (error) { if (!this.isDisposed) this.statusDomNode.textContent = error instanceof Error ? error.message : localize('multiDiff.failed', 'The operation failed.'); }
		finally { this.busy = false; this.domNode.classList.remove('busy'); }
	}
}
class ToolbarAction implements IAction {
	readonly checked = undefined;
	constructor(readonly id: string, readonly label: string, readonly tooltip: string, readonly icon: IAction['icon'], readonly enabled: boolean, private readonly execute: () => unknown) { }
	run(): unknown { return this.execute(); }
}
