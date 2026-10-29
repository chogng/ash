import type { IDimension } from '../../../../base/browser/dom.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { ChatGPTWidget } from './chatGPTWidget.js';
import { chatGPTScrollOptimization } from './chatGPTWeb.js';

export class ChatGPTEditorPane extends EditorPane {
	public readonly id = 'sessions.editor.chatgpt';
	private widget!: ChatGPTWidget;
	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super('sessions.editor.chatgpt', theme, storage);
	}
	public override create(parent: HTMLElement): void {
		const root = parent.ownerDocument.createElement('section');
		root.setAttribute('aria-label', localize('sessions.chatgpt.title', 'ChatGPT'));
		parent.append(root);
		super.create(root);
		const contextKeys = this._register(this.contextKeys.createScoped(root));
		contextKeys.createKey('chatGPTFocused', true);
		// Nested input editors must inherit this page's accessibility context.
		const instantiation = this._register(this.instantiation.createChild(new ServiceCollection([IContextKeyService, contextKeys])));
		this.widget = this._register(instantiation.createInstance(ChatGPTWidget, root));
		const update = (): void => this.widget.setScrollingOptimization(this.configuration.getValue<boolean>(chatGPTScrollOptimization));
		update();
		this._register(
			this.configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(chatGPTScrollOptimization)) {
					update();
				}
			}),
		);
		this._register(
			addDisposableListener(root, 'focusin', event => {
				if (!root.contains(event.relatedTarget as Node) && this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.ChatGPT)) {
					status(localize('sessions.chatgpt.navigationHint', 'Press Alt+F1 for ChatGPT accessibility help.'));
				}
			}),
		);
	}
	public override async setInput(_input: IResourceEditorInput, _signal: AbortSignal): Promise<void> {}
	public override clearInput(): void {}
	public override layout(_dimension: IDimension): void {}
	public override focus(): void {
		this.widget.focus();
	}
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.widget?.setVisible(visible);
	}
}
