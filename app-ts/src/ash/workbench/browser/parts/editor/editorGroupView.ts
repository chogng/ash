import './media/editorgroupview.css';
import { h } from '../../../../base/browser/dom.js';
import type { Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IScopedContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { EditorInput } from './editorInput.js';
import type { FileElement } from './breadcrumbsModel.js';
import type { EditorTabDescriptor, EditorTabsDelegate } from './editorTabsControl.js';
import type { EditorGroupOptions } from './editorGroup.js';
import type { EditorGroupId } from '../../../services/editor/common/editorState.js';
import type { IEditorPane } from './editorPane.js';
import { EditorGroupWatermark } from './editorGroupWatermark.js';
import { EditorPanes, type EditorPaneInstance } from './editorPanes.js';
import { EditorTitleControl } from './editorTitleControl.js';

/** Owns the title, empty-group shortcuts, and pane container for one editor group. */
export class EditorGroupView extends Disposable {
	readonly domNode: HTMLElement;
	readonly panes: EditorPanes;
	readonly scopedContextKeyService: IScopedContextKeyService | undefined;
	private readonly contentDomNode: HTMLDivElement;
	private readonly titleControl: EditorTitleControl;
	private readonly watermark: EditorGroupWatermark | undefined;

	constructor(
		container: HTMLElement,
		titleDelegate: EditorTabsDelegate,
		options: EditorGroupOptions,
		onSelectBreadcrumb?: (element: FileElement) => void,
		group?: EditorGroupId,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-editor-group';
		this.domNode.setAttribute('aria-label', 'Editor group');
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.scopedContextKeyService = options.contextKeyService
			? this._register(options.contextKeyService.createScoped(this.domNode))
			: undefined;
		this.titleControl = this._register(new EditorTitleControl(
			this.domNode,
			titleDelegate,
			options.titleActions ? {
				...options.titleActions,
				contextKeyService: this.scopedContextKeyService,
			} : undefined,
			options.configurationService,
			onSelectBreadcrumb,
			group,
			options.breadcrumbsService,
			options.languageFeaturesService,
			options.showBreadcrumbSymbolPicker,
		));
		this.contentDomNode = h(ownerDocument, 'div');
		this.contentDomNode.className = 'ash-editor-group-content';
		this.panes = this._register(new EditorPanes(this.contentDomNode));
		this.watermark = options.keybindingService
			? this._register(new EditorGroupWatermark(this.contentDomNode, options.keybindingService))
			: undefined;
		this.domNode.append(this.titleControl.domNode, this.contentDomNode);
	}

	get titleHeight(): number {
		return this.titleControl.height;
	}

	setLocked(locked: boolean): void {
		this.titleControl.setLocked(locked);
	}

	get onDidChangeTitleHeight(): Event<void> {
		return this.titleControl.onDidChangeHeight;
	}

	setEditors(editors: readonly EditorTabDescriptor[], activeInput: EditorInput | undefined, activePane?: IEditorPane, selectedIds?: ReadonlySet<string>): void {
		this.titleControl.setEditors(editors, activeInput, activePane, selectedIds);
	}

	renderContent(instances: readonly EditorPaneInstance[], pending: EditorPaneInstance | undefined, ordinaryContent: Element | undefined): void {
		const children: Element[] = [];
		if (ordinaryContent) {
			children.push(ordinaryContent);
		} else {
			if (this.watermark) {
				this.watermark.domNode.hidden = instances.length > 0;
				children.push(this.watermark.domNode);
			}
			children.push(...instances.map(instance => instance.domNode));
		}
		if (pending) children.push(pending.domNode);
		this.contentDomNode.replaceChildren(...children);
	}
}
