import './media/editorgroupview.css';
import { h } from '../../../../base/browser/dom.js';
import type { Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IScopedContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { EditorInput } from './editorInput.js';
import type { EditorTabDescriptor, EditorTabsDelegate } from './editorTabsControl.js';
import type { EditorGroupOptions } from './editorGroup.js';
import { EditorGroupWatermark } from './editorGroupWatermark.js';
import { EditorPanes, type EditorPaneInstance } from './editorPanes.js';
import { EditorTitleControl } from './editorTitleControl.js';
import { EditorWelcome, type IEditorWelcomeProject } from '../../../contrib/files/browser/editorWelcome.js';

/** Owns the title, welcome content, and pane container for one editor group. */
export class EditorGroupView extends Disposable {
	readonly domNode: HTMLElement;
	readonly panes: EditorPanes;
	readonly scopedContextKeyService: IScopedContextKeyService | undefined;
	private readonly contentDomNode: HTMLDivElement;
	private readonly titleControl: EditorTitleControl;
	private readonly welcome: EditorWelcome;
	private welcomeVisible: boolean;

	constructor(container: HTMLElement, titleDelegate: EditorTabsDelegate, options: EditorGroupOptions) {
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
		));
		this.contentDomNode = h(ownerDocument, 'div');
		this.contentDomNode.className = 'ash-editor-group-content';
		this.panes = this._register(new EditorPanes(this.contentDomNode));
		const shortcuts = options.keybindingService
			? this._register(new EditorGroupWatermark(this.contentDomNode, options.keybindingService))
			: undefined;
		this.welcome = this._register(new EditorWelcome(this.contentDomNode, {
			...options.welcome,
			...(shortcuts ? { shortcuts: shortcuts.domNode } : {}),
		}));
		this.welcomeVisible = options.welcomeVisible ?? true;
		this.welcome.element.hidden = !this.welcomeVisible;
		this.domNode.append(this.titleControl.domNode, this.contentDomNode);
	}

	get titleHeight(): number {
		return this.titleControl.height;
	}

	get onDidChangeTitleHeight(): Event<void> {
		return this.titleControl.onDidChangeHeight;
	}

	setEditors(editors: readonly EditorTabDescriptor[], activeInput: EditorInput | undefined): void {
		this.titleControl.setEditors(editors, activeInput);
	}

	setWelcomeRecentProjects(projects: readonly IEditorWelcomeProject[]): void {
		this.welcome.setRecentProjects(projects);
	}

	setWelcomeVisible(visible: boolean): boolean {
		if (this.welcomeVisible === visible) return false;
		this.welcomeVisible = visible;
		return true;
	}

	renderContent(instances: readonly EditorPaneInstance[], pending: EditorPaneInstance | undefined, ordinaryContent: Element | undefined): void {
		const children: Element[] = [];
		if (ordinaryContent) {
			children.push(ordinaryContent);
		} else {
			this.welcome.element.hidden = !this.welcomeVisible || instances.length > 0;
			children.push(this.welcome.element, ...instances.map(instance => instance.domNode));
		}
		if (pending) children.push(pending.domNode);
		this.contentDomNode.replaceChildren(...children);
	}
}
