import './media/typeHierarchy.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { AsyncDataTree } from '../../../../base/browser/ui/tree/asyncDataTree.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableMap } from '../../../../base/common/lifecycle.js';
import { type LanguageHierarchyItem } from '../../../../editor/common/languages.js';
import { type ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { PeekViewWidget } from '../../../../editor/contrib/peekView/browser/peekView.js';
import { localize } from '../../../../nls.js';
import { TypeHierarchyModel, TypeHierarchyDirection } from '../common/typeHierarchy.js';
import { Type, DataSource } from './typeHierarchyTree.js';

export class TypeHierarchyTreePeekWidget extends PeekViewWidget {
	private readonly selected = this._register(new Emitter<LanguageHierarchyItem>());
	public readonly onDidSelectItem = this.selected.event;
	private readonly rows = this._register(new DisposableMap<Type, Button>());
	private readonly tree: AsyncDataTree<TypeHierarchyModel, Type>;
	private readonly buttons: readonly Button[];
	private model: TypeHierarchyModel | undefined;
	private currentDirection = TypeHierarchyDirection.Subtypes;

	public get direction(): TypeHierarchyDirection { return this.currentDirection; }

	constructor(editor: ICodeEditor, onError: (error: unknown) => void) {
		super(editor);
		const body = h(this.element.ownerDocument, 'div');
		body.className = 'stanza-editor-language-hierarchy ash-type-hierarchy';
		const toolbar = h(body.ownerDocument, 'div');
		toolbar.className = 'ash-type-hierarchy-directions';
		const treeContainer = h(body.ownerDocument, 'div');
		treeContainer.className = 'ash-type-hierarchy-tree';
		body.append(toolbar, treeContainer);
		this.setBody(body);
		this.setTitle(localize('typeHierarchy.title', 'Type Hierarchy'));
		const directions: readonly (readonly [TypeHierarchyDirection, string])[] = [
			[TypeHierarchyDirection.Subtypes, localize('hierarchy.subtypes', 'Subtypes')],
			[TypeHierarchyDirection.Supertypes, localize('hierarchy.supertypes', 'Supertypes')],
		];
		this.buttons = directions.map(([direction, label]) => {
			const button = this._register(new Button(toolbar, {
				label, checked: direction === this.currentDirection, presentation: 'quiet', size: 'small',
				onClick: () => { void this.expandDirection(direction).catch(onError); },
			}));
			button.domNode.classList.add('stanza-editor-language-hierarchy-expand');
			return button;
		});
		this.tree = this._register(new AsyncDataTree<TypeHierarchyModel, Type>(treeContainer, new DataSource(() => this.direction), {
			ariaLabel: localize('typeHierarchy.title', 'Type Hierarchy'),
			onDidRemoveRow: row => {
				for (const [node, button] of this.rows) {
					if (row.contains(button.domNode)) { this.rows.deleteAndDispose(node); }
				}
			},
			expandOnlyOnTwistieClick: true,
			collapseByDefault: () => true,
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: node => node.item.name },
			renderElement: node => {
				this.rows.deleteAndDispose(node);
				const button = new Button(treeContainer, {
					label: node.item.detail ? node.item.name + ' — ' + node.item.detail : node.item.name,
					title: node.item.resource.path, presentation: 'quiet', size: 'small',
					onClick: () => this.selected.fire(node.item),
				});
				this.rows.set(node, button);
				button.domNode.classList.add('stanza-editor-language-hierarchy-item');
				return button.domNode;
			},
		}));
		this._register(this.tree.onDidError(event => {
			if (!this.isDisposed) { onError(event.error); }
		}));
		this._register(this.tree.onDidAccept(event => this.selected.fire(event.element.item)));
	}

	public async showModel(model: TypeHierarchyModel): Promise<void> {
		this.model = model;
		await this.tree.setInput(model);
		if (this.isDisposed) { return; }
		const first = this.tree.getVisibleElements()[0];
		if (first) { this.tree.setFocus(first); }
		this.buttons.forEach(button => button.domNode.setAttribute('aria-label',
			localize('hierarchy.directionFor', '{0} for {1}', button.label, model.roots[0]!.name)));
	}

	public async updateDirection(direction: TypeHierarchyDirection): Promise<void> {
		this.currentDirection = direction;
		this.buttons[0]!.checked = direction === TypeHierarchyDirection.Subtypes;
		this.buttons[1]!.checked = !this.buttons[0]!.checked;
		await this.tree.setInput(this.model);
	}

	private async expandDirection(direction: TypeHierarchyDirection): Promise<void> {
		if (direction !== this.direction) { await this.updateDirection(direction); }
		const root = this.tree.getVisibleElements()[0];
		if (root) { this.tree.expand(root); }
	}
}
