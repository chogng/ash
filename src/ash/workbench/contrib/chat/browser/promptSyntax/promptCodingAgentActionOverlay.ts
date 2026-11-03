import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { type ICodeEditor, type IOverlayWidget, OverlayWidgetPositionPreference } from '../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { localize } from '../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { getPromptFileType, PromptsType } from '../../common/promptSyntax/promptTypes.js';

export class PromptCodingAgentActionOverlayWidget extends Disposable implements IOverlayWidget {
	private readonly node: HTMLElement;

	constructor(
		private readonly editor: ICodeEditor,
		@ICommandService commands: ICommandService,
		@IConfigurationService configuration: IConfigurationService,
		@INotificationService notifications: INotificationService,
		@IContextKeyService contexts: IContextKeyService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
	) {
		super();
		this.node = editor.getContainerDomNode().ownerDocument.createElement('div');
		const button = this._register(new Button(this.node, {
			...defaultButtonStyles,
			label: localize('prompt.agent.openDraft', 'New Chat with Agent'),
		}));
		const context = this._register(contexts.createScoped(this.node));
		context.createKey('promptAgentOverlay', true);
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help,
			priority: 100,
			name: `promptAgentOverlay.${editor.getId()}`,
			when: ContextKeyExpr.has('promptAgentOverlay'),
			getProvider: accessor => {
				if (accessor.get(IContextKeyService) !== contexts) return undefined;
				const focused = this.node.ownerDocument.activeElement;
				if (this.node.hidden || !this.node.contains(focused)) return undefined;
				return new AccessibleContentProvider(
					AccessibleViewProviderId.Editor,
					{ type: AccessibleViewType.Help },
					() => localize('prompt.agent.overlayHelp', 'Press Enter or Space to open an unsent chat with this saved Agent. Press Escape to return to the document.'),
					() => this.node.isConnected && !this.node.hidden ? button.focus() : editor.focus(),
					AccessibilityVerbositySettingId.Editor,
				);
			},
		}));
		this._register(addDisposableListener(this.node, 'focusin', () => {
			const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Editor);
			if (hint) this.node.setAttribute('aria-description', hint);
			else this.node.removeAttribute('aria-description');
		}));
		this._register(button.onDidClick(() => {
			const resource = editor.getModel()?.uri;
			if (!resource || this.node.hidden) return;
			void commands.executeCommand('workbench.action.chat.newWithCurrentAgent', resource.toString()).catch(error => notifications.error(error));
		}));
		this._register(addDisposableListener(this.node, 'keydown', event => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				editor.focus();
			}
		}));
		const update = () => {
			const hidden = editor.getOption(EditorOption.inDiffEditor)
				|| editor.getOption(EditorOption.readOnly)
				|| getPromptFileType(editor.getModel()?.uri) !== PromptsType.agent
				|| configuration.getValue<boolean>(ChatAIDisabledSettingId);
			if (hidden && this.node.contains(this.node.ownerDocument.activeElement)) editor.focus();
			this.node.hidden = hidden;
			editor.layoutOverlayWidget(this);
		};
		editor.addOverlayWidget(this);
		this._register(toDisposable(() => editor.removeOverlayWidget(this)));
		this._register(editor.onDidChangeModel(update));
		this._register(editor.onDidChangeConfiguration(update));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatAIDisabledSettingId)) update();
		}));
		update();
	}

	getId(): string { return 'ash.prompt.agentAction'; }
	getDomNode(): HTMLElement { return this.node; }
	getPosition() { return this.node.hidden ? null : { preference: OverlayWidgetPositionPreference.TOP_RIGHT_CORNER }; }
}
