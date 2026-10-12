import '../../../src/ash/workbench/contrib/chat/browser/chat.contribution.js';
import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/editor/browser/coreCommands.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { Selection } from '../../../src/ash/editor/common/core/selection.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { CodeEditorWidget } from '../../../src/ash/editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { StandaloneCommandService } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { ChatListWidget } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatListWidget.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../src/ash/workbench/common/contributions.js';
import { EditorExtensionsRegistry } from '../../../src/ash/editor/browser/editorExtensions.js';
import { SuggestController } from '../../../src/ash/editor/contrib/suggest/browser/suggestController.js';
import '../../../src/ash/editor/contrib/hover/browser/hoverContribution.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { IEditorPart } from '../../../src/ash/workbench/browser/parts/editor/editorPart.js';
import { IUntitledTextEditorService } from '../../../src/ash/workbench/services/untitled/common/untitledTextEditorService.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { BrowserClipboardService } from '../../../src/ash/platform/clipboard/browser/clipboardService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { formatNlsMessage, setNlsResolver } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';

const locale = new URLSearchParams(location.search).get('locale');
if (locale) {
	const catalog = productLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
}
const resources = new DisposableStore();
const services = resources.add(createTestEditorServices(undefined, undefined, document));
const theme = services.get(IThemeService) as TestThemeService;
resources.add(bindColorTheme(theme, document.body));
let clipboardText = '';
class Clipboard extends BrowserClipboardService {
	constructor() { super(undefined); }
	public override async writeText(text: string): Promise<void> { clipboardText = text; }
}
services.registerInstance(IClipboardService, resources.add(new Clipboard()));
services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
registerCodeEditorServices(services);
const promptContributions = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.chatPromptSyntax']));
promptContributions.advance(WorkbenchPhase.BlockStartup);
const fileContainer = document.createElement('section');
fileContainer.style.cssText = 'width:600px;height:140px';
fileContainer.setAttribute('aria-label', 'File editor');
document.body.append(fileContainer);
const promptFile = new URLSearchParams(location.search).has('prompt');
const fileModel = resources.add(new TextModel(promptFile ? '---\n\n---\nBody' : 'before after', {
	resource: URI.parse(promptFile ? 'inmemory://fixture/review/SKILL.md' : 'inmemory://fixture/file.ts'), languageId: promptFile ? 'markdown' : 'typescript',
}));
const file = resources.add(services.createInstance(CodeEditorWidget, {
	container: fileContainer, model: fileModel,
	contributions: promptFile ? EditorExtensionsRegistry.getSomeEditorContributions([SuggestController.ID, 'editor.contrib.hover']) : [],
}));
file.layout({ width: 600, height: 140 });
file.setSelection(promptFile ? new Selection(2, 1, 2, 1) : new Selection(1, 8, 1, 8));
let activeResource = fileModel.uri;
services.registerInstance(IEditorPart, { get activePane() { return { getControl: () => file }; } } as unknown as IEditorPart);
services.registerInstance(IEditorService, {
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None,
	get activeEditor() { return { resource: activeResource }; },
	visibleEditorPanes: [],
	get visibleEditors() { return [{ resource: activeResource }]; },
	openEditor: async input => {
		const model = await services.get(IUntitledTextEditorService).resolve({ untitledResource: input.resource });
		activeResource = input.resource;
		file.setModel(model.textEditorModel!);
	},
	save: async () => ({ success: true, editors: [] }), saveAll: async () => ({ success: true, editors: [] }),
	focusActiveEditor: () => file.focus(),
});
const root = document.createElement('main');
root.style.cssText = 'display:flex;width:600px;height:400px';
document.body.append(root);
const list = resources.add(services.createInstance(ChatListWidget, root, {}));
list.setVisible(true);
let text = 'Reply with `inline`.\n\n```typescript\nconst code = "<safe>";\nsecond line\n```';
list.render([{ id: 'reply', type: 'agentMessage', text, transient: false }]);

declare global {
	interface Window {
		ashChatTranscriptIntegration: {
			state(): { copied: string; file: string; resource: string; editorCount: number; selection: unknown; notifications: readonly string[]; };
			setReadonly(value: boolean): void;
			setWrap(value: boolean): Promise<void>;
			setCodeLineHeight(height: number): Promise<void>;
			setTheme(value: 'dark' | 'light' | 'hc'): void;
			refresh(): void;
			showLongCode(): string;
			remove(): void;
			dispose(): void;
		};
	}
}
window.ashChatTranscriptIntegration = {
	state: () => ({
		copied: clipboardText, file: file.getModel()!.getValue(), resource: activeResource.toString(),
		editorCount: services.get(ICodeEditorService).listCodeEditors().length,
		selection: services.get(ICodeEditorService).listCodeEditors().find(editor => editor !== file)?.getSelection(),
		notifications: services.get(INotificationService).getNotifications().map(item => item.message),
	}),
	setReadonly: value => file.updateOptions({ readOnly: value }),
	setWrap: value => services.get(IConfigurationService).updateValue('chat.editor.wordWrap', value ? 'on' : 'off'),
	setCodeLineHeight: height => services.get(IConfigurationService).updateValue('chat.editor.lineHeight', height),
	setTheme: value => {
		const palette = value === 'dark' ? darkColorTheme : value === 'light' ? lightColorTheme : highContrastDarkColorTheme;
		theme.setColorTheme(palette);
	},
	refresh: () => list.render([{ id: 'reply', type: 'agentMessage', text, transient: false }]),
	showLongCode: () => {
		const code = Array.from({ length: 80 }, (_, index) => `const value${index} = ${index};`).join('\n');
		text = `\`\`\`typescript\n${code}\n\`\`\``;
		list.render([{ id: 'reply', type: 'agentMessage', text, transient: false }]);
		return code;
	},
	remove: () => list.render([]),
	dispose: () => resources.dispose(),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
