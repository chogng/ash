import './media/openeditors.css';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { ObjectTree } from '../../../../../base/browser/ui/tree/objectTree.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize, onDidChangeNls } from '../../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IResourceIconRenderer } from '../../../../browser/labels.js';
import { basenameOrAuthority } from '../../../../browser/resourceLabelHelpers.js';
import { ViewPane, type IViewPaneOptions } from '../../../../browser/parts/views/viewPane.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import type { EditorInstanceState } from '../../../../services/editor/common/editorState.js';
import { OpenEditorsFocusedContext } from '../../common/files.js';

type OpenEditorsRow =
	| { readonly kind: 'group'; readonly id: string; readonly label: string }
	| { readonly kind: 'editor'; readonly id: string; readonly editor: EditorInstanceState; readonly isActive: boolean };

/** Shows the editor instances already owned by the Workbench editor groups. */
export class OpenEditorsView extends ViewPane {
	public static readonly ID = 'workbench.explorer.openEditorsView';
	private readonly rowDisposables = this._register(new DisposableStore());
	private readonly tree: ObjectTree<OpenEditorsRow>;
	private readonly emptyDomNode: HTMLDivElement;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IEditorPart private readonly editorPart: IEditorPart,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IConfigurationService configuration: IConfigurationService,
		@IResourceIconRenderer resourceIcons: IResourceIconRenderer,
	) {
		super(container, options);
		this.contentElement.classList.add('ash-open-editors');
		const document = container.ownerDocument;
		this.emptyDomNode = h(document, 'div');
		this.emptyDomNode.className = 'ash-open-editors-empty';
		this.emptyDomNode.setAttribute('role', 'status');
		this.emptyDomNode.tabIndex = 0;
		this.tree = this._register(new ObjectTree<OpenEditorsRow>(this.contentElement, {
			ariaLabel: localize('files.openEditors.title', 'Open Editors'),
			modelOptions: {
				defaultCollapseState: 'expanded',
				identityProvider: { getId: row => row.id },
			},
			onWillRender: () => this.rowDisposables.clear(),
			renderElement: row => this.renderRow(row, document, resourceIcons),
		}));
		this.tree.element.classList.add('ash-open-editors-tree');
		this.contentElement.append(this.emptyDomNode);
		const scopedContext = this._register(contextKeys.createScoped(this.contentElement));
		OpenEditorsFocusedContext.bindTo(scopedContext).set(true);
		const updateLabel = () => {
			const label = localize('files.openEditors.title', 'Open Editors');
			const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.OpenEditors);
			this.tree.element.setAttribute('aria-label', hint ? `${label}. ${hint}` : label);
			this.emptyDomNode.textContent = localize('files.openEditors.empty', 'No open editors');
			this.refresh();
		};
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.OpenEditors)) updateLabel();
		}));
		this._register(onDidChangeNls(updateLabel));
		this._register(editorPart.onDidChangeEditors(() => this.refresh()));
		this._register(resourceIcons.onDidChangeResourceIcons(() => this.tree.rerender()));
		this._register(this.tree.onPointer(({ element, browserEvent }) => {
			if (browserEvent.button === 0 && element.kind === 'editor') this.activate(element.editor);
		}));
		this._register(this.tree.onDidAccept(({ element }) => {
			if (element.kind === 'group') this.tree.toggleCollapsed(element.id);
			else this.activate(element.editor);
		}));
		this._register(addDisposableListener(this.tree.element, 'keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Delete' && event.key !== 'Backspace') return;
			const row = this.tree.focus;
			if (row?.kind !== 'editor') return;
			event.preventDefault();
			void this.close(row.editor);
		}));
		updateLabel();
	}

	public override focus(): void {
		if (this.tree.element.hidden) this.emptyDomNode.focus();
		else this.tree.domFocus();
	}

	public getAccessibleContent(): string {
		const groups = this.editorPart.groups;
		const lines = [localize('files.openEditors.title', 'Open Editors')];
		if (groups.every(group => group.editors.length === 0)) {
			lines.push(localize('files.openEditors.empty', 'No open editors'));
			return lines.join('\n');
		}
		for (const [index, group] of groups.entries()) {
			if (groups.length > 1) lines.push(localize('files.openEditors.group', 'Group {0}', index + 1));
			for (const editor of group.editors) {
				const label = editor.input.label ?? basenameOrAuthority(editor.input.resource);
				const state = editor.isDirty ? localize('files.openEditors.unsaved', 'Unsaved changes') : '';
				lines.push(state ? `${label}, ${state}` : label);
			}
		}
		return lines.join('\n');
	}

	private refresh(): void {
		const groups = this.editorPart.groups;
		const previousFocus = this.tree.focus?.id;
		const previousSelection = this.tree.selection.map(row => row.id);
		const activeGroup = this.editorPart.activeGroup;
		const activeEditor = activeGroup.editors.find(editor => editor.isActive);
		const activeId = activeEditor ? `editor:${activeGroup.id}:${activeEditor.instanceId}` : undefined;
		const rows = groups.length === 1
			? groups[0]!.editors.map(editor => ({ element: this.editorRow(editor, groups[0]!.id) }))
			: groups.map((group, index) => ({
				element: { kind: 'group', id: `group:${group.id}`, label: localize('files.openEditors.group', 'Group {0}', index + 1) } as OpenEditorsRow,
				children: group.editors.map(editor => ({ element: this.editorRow(editor, group.id) })),
				collapsible: true,
			}));
		this.tree.setChildren(rows);
		if (previousFocus && this.tree.model.has(previousFocus)) this.tree.setFocus(previousFocus);
		else if (activeId && this.tree.model.has(activeId)) this.tree.setFocus(activeId);
		const selection = previousSelection.filter(id => this.tree.model.has(id));
		if (selection.length === 0 && activeId && this.tree.model.has(activeId)) selection.push(activeId);
		this.tree.setSelection(selection);
		this.emptyDomNode.hidden = groups.some(group => group.editors.length > 0);
		this.tree.element.hidden = !this.emptyDomNode.hidden;
	}

	private editorRow(editor: EditorInstanceState, groupId: string): OpenEditorsRow {
		return { kind: 'editor', id: `editor:${groupId}:${editor.instanceId}`, editor, isActive: this.editorPart.activeGroup.id === groupId && editor.isActive };
	}

	private renderRow(row: OpenEditorsRow, document: Document, resourceIcons: IResourceIconRenderer): HTMLElement {
		const content = h(document, 'span');
		content.className = 'ash-open-editors-row';
		if (row.kind === 'group') {
			content.classList.add('ash-open-editors-group');
			content.textContent = row.label;
			return content;
		}
		content.classList.toggle('active', row.isActive);
		content.classList.toggle('preview', row.editor.isPreview);
		const icon = h(document, 'span');
		icon.className = 'ash-open-editors-icon';
		icon.setAttribute('aria-hidden', 'true');
		resourceIcons.renderFileIcon(row.editor.input.resource, icon);
		const label = h(document, 'span');
		label.className = 'ash-open-editors-label';
		label.textContent = row.editor.input.label ?? basenameOrAuthority(row.editor.input.resource);
		label.title = row.editor.input.resource.toString();
		content.append(icon, label);
		if (row.editor.isDirty) {
			const dirty = h(document, 'span');
			dirty.className = 'ash-open-editors-dirty';
			dirty.textContent = localize('files.openEditors.unsaved', 'Unsaved changes');
			content.append(dirty);
		}
		const close = h(document, 'button');
		close.type = 'button';
		close.className = 'ash-open-editors-close';
		close.setAttribute('aria-label', localize('files.openEditors.close', 'Close {0}', label.textContent));
		close.title = close.getAttribute('aria-label') ?? '';
		appendIcon(Lxicon.close, close).setAttribute('aria-hidden', 'true');
		this.rowDisposables.add(addDisposableListener(close, 'click', (event: MouseEvent) => {
			event.stopPropagation();
			void this.close(row.editor);
		}));
		this.rowDisposables.add(addDisposableListener(close, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
		}));
		content.append(close);
		return content;
	}

	private activate(editor: EditorInstanceState): void {
		this.editorPart.activateEditorIdentifier(editor);
	}

	private async close(editor: EditorInstanceState): Promise<void> {
		if (await this.editorPart.closeEditorIdentifier(editor)) this.focus();
	}
}
