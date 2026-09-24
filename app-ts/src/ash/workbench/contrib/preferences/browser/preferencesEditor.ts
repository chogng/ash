import './media/preferencesEditor.css';
import { h } from '../../../../base/browser/dom.js';
import { Dimension, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import type { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import { isPreferencesEditorInput } from '../../../services/preferences/common/preferencesEditorInput.js';
import { PreferencesEditorPanes, type IPreferencesEditorPane, type PreferencesEditorPaneRegistry } from './preferencesEditorRegistry.js';
import { PreferencesSearchWidget } from './preferencesWidgets.js';

export const PreferencesEditorId = 'workbench.editor.preferences';

let nextPreferencesEditorId = 1;

/** Shared Preferences shell. Product-specific preference panes arrive through the registry. */
export class PreferencesEditor extends Disposable implements IEditorPane {
	public readonly id = PreferencesEditorId;

	private readonly activePane = this._register(new MutableDisposable<IPreferencesEditorPane>());
	private bodyDomNode: HTMLDivElement | undefined;
	private dimension = Dimension.Zero;
	private rootDomNode: HTMLDivElement | undefined;
	private searchWidget: PreferencesSearchWidget | undefined;
	private visible = false;

	constructor(
		private readonly instantiationService: IInstantiationService,
		private readonly localizationService: ILocalizationService,
		private readonly paneRegistry: PreferencesEditorPaneRegistry = PreferencesEditorPanes,
	) {
		super();
		this._register(this.paneRegistry.onDidRegisterPreferencesEditorPanes(() => this.ensureActivePane()));
		this._register(this.paneRegistry.onDidDeregisterPreferencesEditorPanes(() => this.ensureActivePane()));
	}

	create(parent: HTMLElement): void {
		if (this.rootDomNode) throw new Error('Preferences editor has already been created');
		const ownerDocument = parent.ownerDocument;
		this.rootDomNode = h(ownerDocument, 'div');
		this.rootDomNode.className = 'ash-settings-editor';
		const bodyId = `ash-preferences-editor-body-${nextPreferencesEditorId++}`;

		this.searchWidget = this._register(new PreferencesSearchWidget(this.rootDomNode, {
			ariaControls: bodyId,
			contextMenuProvider: this.instantiationService.get(IContextMenuService),
			localizationService: this.localizationService,
		}));
		this._register(this.searchWidget.onDidChange(value => this.activePane.value?.search(value)));
		this._register(this.searchWidget.onDidRequestFocusResults(() => this.activePane.value?.focus()));

		this.bodyDomNode = h(ownerDocument, 'div');
		this.bodyDomNode.className = 'ash-preferences-editor-body';
		this.bodyDomNode.id = bodyId;
		this.rootDomNode.append(this.bodyDomNode);
		parent.append(this.rootDomNode);
		this._register(toDisposable(() => this.rootDomNode?.remove()));
	}

	async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (!isPreferencesEditorInput(input)) throw new TypeError(`Preferences editor cannot open ${input.resource}`);
		if (signal.aborted) throw signal.reason;
		this.ensureActivePane();
	}

	clearInput(): void {
		if (this.searchWidget) this.searchWidget.value = '';
	}

	layout(dimension: IDimension): void {
		this.dimension = new Dimension(dimension.width, dimension.height);
		this.activePane.value?.layout(new Dimension(
			this.bodyDomNode?.clientWidth ?? dimension.width,
			this.bodyDomNode?.clientHeight ?? Math.max(0, dimension.height - 44),
		));
	}

	setVisible(visibility: EditorPaneVisibility): void {
		this.visible = visibility === EditorPaneVisibility.Visible;
	}

	focus(): void {
		if (!this.visible) return;
		this.searchWidget?.focus();
	}

	private ensureActivePane(): void {
		if (!this.bodyDomNode) return;
		const descriptor = this.paneRegistry.getPreferencesEditorPanes()[0];
		const current = this.activePane.value;
		if (!descriptor) {
			this.activePane.clear();
			this.bodyDomNode.replaceChildren();
			return;
		}
		if (current?.getDomNode().dataset.preferencesPaneId === descriptor.id) return;
		const pane = this.instantiationService.createInstance(descriptor.ctorDescriptor, this.bodyDomNode);
		pane.getDomNode().dataset.preferencesPaneId = descriptor.id;
		this.activePane.value = pane;
		this.bodyDomNode.replaceChildren(pane.getDomNode());
		pane.search(this.searchWidget?.value ?? '');
		this.layout(this.dimension);
	}
}
