import { h, type IDimension } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { localize } from '../../../../../nls.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { CONTEXT_MODELS_EDITOR } from '../../common/constants.js';
import { ChatModelsWidget } from './chatModelsWidget.js';
import './media/chatManagementEditor.css';

export class ModelsManagementEditor extends EditorPane {
	public static readonly ID = 'workbench.editor.modelsManagement';
	public readonly id = ModelsManagementEditor.ID;
	private widget!: ChatModelsWidget;
	private dimension: IDimension | undefined;

	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IPreferencesService private readonly preferences: IPreferencesService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super(ModelsManagementEditor.ID, theme, storage);
	}

	public override create(container: HTMLElement): void {
		const document = container.ownerDocument;
		const root = h(document, 'section');
		root.className = 'ash-models-management-editor';
		container.append(root);
		super.create(root);
		const title = h(document, 'h2');
		title.textContent = localize('modelsManagementEditorInputName', 'Language Models');
		root.append(title);
		const settings = this._register(new Button(root, {
			...defaultButtonStyles,
			label: localize('chat.modelPicker.openSettings', 'Open Settings'),
			presentation: 'secondary',
		}));
		this._register(settings.onDidClick(() => { void this.preferences.openSettings({ section: 'models' }); }));
		this.widget = this._register(this.instantiation.createInstance(ChatModelsWidget, document, {}));
		const count = h(document, 'p');
		count.className = 'ash-models-count';
		count.setAttribute('role', 'status');
		this._register(this.widget.onDidChangeItemCount(value => { count.textContent = localize('models.catalog.count', 'Showing {0} models', value); }));
		root.append(count);
		root.append(this.widget.element);
		this.widget.fireItemCount();
		const scope = this._register(this.contextKeys.createScoped(root));
		CONTEXT_MODELS_EDITOR.bindTo(scope).set(true);
	}

	public override async setInput(_input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		this.widget.element.hidden = false;
		this.widget.render();
		this.widget.fireItemCount();
	}

	public override clearInput(): void { this.widget.element.hidden = true; }
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		const wasHidden = this.widget.element.hidden;
		this.widget.element.hidden = !visible;
		// EditorPanes lays out a hidden host before revealing it. Measure its chrome only after reveal.
		if (visible && this.dimension) { this.layout(this.dimension); }
		if (visible && wasHidden) { this.widget.render(); this.widget.fireItemCount(); }
	}
	public override focus(): void { this.widget.focusSearch(); }
	public search(query: string): void { this.widget.search(query); }
	public clearSearch(): void { this.widget.clearSearch(); }

	public override layout(dimension: IDimension): void {
		this.dimension = dimension;
		const root = this.getContainer()!;
		root.style.width = `${dimension.width}px`;
		root.style.height = `${dimension.height}px`;
		if (!root.clientWidth || !root.clientHeight) { return; }
		const style = root.ownerDocument.defaultView!.getComputedStyle(root);
		const offset = this.widget.element.getBoundingClientRect().top - root.getBoundingClientRect().top;
		this.widget.layout(
			root.clientHeight - offset - Number.parseFloat(style.paddingBottom || '0'),
			root.clientWidth - Number.parseFloat(style.paddingLeft || '0') - Number.parseFloat(style.paddingRight || '0'),
		);
	}
}
