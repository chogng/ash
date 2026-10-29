import { getClientArea, type IDimension } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { ILayoutService, type ILayoutContainerEvent, type ILayoutOffsetInfo } from '../../../platform/layout/browser/layoutService.js';
import type { ICodeEditor } from '../../browser/editorBrowser.js';
import { ICodeEditorService } from '../../browser/services/codeEditorService.js';

const noOffset: ILayoutOffsetInfo = Object.freeze({ top: 0, quickInputTop: 0 });

/** Publishes the container geometry of standalone editors in one browser window. */
export class StandaloneLayoutService extends Disposable implements ILayoutService {
	private readonly layoutMain = this._register(new Emitter<IDimension>());
	private readonly layoutContainer = this._register(new Emitter<ILayoutContainerEvent>());
	private readonly layoutActive = this._register(new Emitter<IDimension>());
	private readonly activeChanged = this._register(new Emitter<void>());
	private readonly editorListeners = this._register(new DisposableMap<ICodeEditor, DisposableStore>());
	private lastActiveContainer: HTMLElement;

	public readonly onDidLayoutMainContainer = this.layoutMain.event;
	public readonly onDidLayoutContainer = this.layoutContainer.event;
	public readonly onDidLayoutActiveContainer = this.layoutActive.event;
	public readonly onDidChangeActiveContainer = this.activeChanged.event;
	public readonly mainContainerOffset = noOffset;
	public readonly activeContainerOffset = noOffset;

	constructor(@ICodeEditorService private readonly editors: ICodeEditorService) {
		super();
		this.lastActiveContainer = this.activeContainer;
		this._register(editors.onCodeEditorAdd(editor => {
			this.track(editor);
			this.publishLayout(editor);
			this.publishActiveContainer();
		}));
		this._register(editors.onCodeEditorRemove(editor => {
			this.editorListeners.deleteAndDispose(editor);
			this.publishActiveContainer();
			this.layoutMain.fire(this.mainContainerDimension);
			this.layoutActive.fire(this.activeContainerDimension);
		}));
		for (const editor of editors.listCodeEditors()) {
			this.track(editor);
		}
	}

	public get mainContainer(): HTMLElement {
		return this.editors.listCodeEditors()[0]?.getContainerDomNode() ?? document.body;
	}

	public get activeContainer(): HTMLElement {
		const editor = this.editors.getFocusedCodeEditor() ?? this.editors.getActiveCodeEditor();
		return editor?.getContainerDomNode() ?? this.mainContainer;
	}

	public get mainContainerDimension(): IDimension {
		return getClientArea(this.mainContainer);
	}

	public get activeContainerDimension(): IDimension {
		return getClientArea(this.activeContainer);
	}

	public get containers(): Iterable<HTMLElement> {
		return this.editors.listCodeEditors().map(editor => editor.getContainerDomNode());
	}

	public getContainer(targetWindow: Window): HTMLElement {
		const container = this.activeContainer;
		if (container.ownerDocument.defaultView !== targetWindow) {
			throw new Error('Layout container is not registered');
		}
		return container;
	}

	public whenContainerStylesLoaded(targetWindow: Window): Promise<void> | undefined {
		this.getContainer(targetWindow);
		return undefined;
	}

	public focus(): void {
		(this.editors.getFocusedCodeEditor() ?? this.editors.getActiveCodeEditor())?.focus();
	}

	private track(editor: ICodeEditor): void {
		const listeners = this.editorListeners.set(editor, new DisposableStore());
		listeners.add(editor.onDidLayoutChange(() => this.publishLayout(editor)));
		listeners.add(editor.onDidFocusEditorText(() => this.publishActiveContainer()));
		listeners.add(editor.onDidFocusEditorWidget(() => this.publishActiveContainer()));
		listeners.add(editor.onDidBlurEditorWidget(() => this.publishActiveContainer()));
	}

	private publishLayout(editor: ICodeEditor): void {
		const container = editor.getContainerDomNode();
		const dimension = getClientArea(container);
		this.layoutContainer.fire({ container, dimension });
		if (container === this.mainContainer) {
			this.layoutMain.fire(dimension);
		}
		if (container === this.activeContainer) {
			this.layoutActive.fire(dimension);
		}
	}

	private publishActiveContainer(): void {
		const container = this.activeContainer;
		if (container === this.lastActiveContainer) {
			return;
		}
		this.lastActiveContainer = container;
		this.activeChanged.fire();
		this.layoutActive.fire(getClientArea(container));
	}
}
