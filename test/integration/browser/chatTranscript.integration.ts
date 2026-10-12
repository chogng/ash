import { ITextModelService } from '../../../src/ash/editor/common/services/resolverService.js';
import { LinkDetector } from '../../../src/ash/editor/contrib/links/browser/links.js';
import { IPromptsService } from '../../../src/ash/workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../src/ash/workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { CancellationToken } from '../../../src/ash/base/common/cancellation.js';
import { IAgentCapabilitiesService } from '../../../src/ash/platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IAgentThreadService } from '../../../src/ash/platform/agentHost/common/agentService.js';
import toneWav from '../../../crates/utils/audio/tests/fixtures/tone.wav?url';
import type { AppServerProtocolClient } from '../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import type { ThreadTranscriptUpdateEnvelope as TranscriptDto, ServerNotification } from '../../../.build/protocol/typescript/index.js';
import type { ThreadTranscriptUpdateEnvelope } from '../../../src/ash/platform/agentHost/common/agentService.js';
import { BrowserLayoutService, ILayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { AccessibleViewType } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { AccessibleViewService } from '../../../src/ash/workbench/contrib/accessibility/browser/accessibleView.js';
import '../../../src/ash/workbench/contrib/chat/browser/chat.contribution.js';
import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/editor/browser/coreCommands.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { Selection } from '../../../src/ash/editor/common/core/selection.js';
import { IModelService } from '../../../src/ash/editor/common/services/model.js';
import { ILanguageService } from '../../../src/ash/editor/common/languages/language.js';
import { IMarkerService } from '../../../src/ash/platform/markers/common/markers.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { CodeEditorWidget } from '../../../src/ash/editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { StandaloneCommandService } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { chatTranscriptListItems } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatListItems.js';
import { createAppServerAgentThreadService } from '../../../src/ash/platform/agentHost/browser/appServerAgentService.js';
import type { ThreadTranscriptEntry } from '../../../src/ash/platform/agentHost/common/agentService.js';
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
services.registerInstance(IAgentCapabilitiesService, { isAvailable: true, read: async () => ({ tools: [{ name: 'read_file', description: 'Read authorized files', source: 'local', sourceDetails: ['Ash'], exposure: 'direct', authority: 'directoryRead' }, { name: 'internal_tool', description: 'Internal', source: 'local', sourceDetails: [], exposure: 'hidden', authority: 'providerDefined' }], toolSets: [], localProcessSandboxConfigured: false, directoryGrantsReadable: true, sandboxBackends: [], sandboxDiagnostics: [] }) });
const skillResourceRequests: unknown[] = [];
const prompts = resources.add(new PromptsService({ onDidChangeSkills: Event.None,
	list: async () => ({ generation: 1, skills: [{ id: { source: 'user:review', name: 'review' }, description: 'Review', contentDigest: `sha256:${'a'.repeat(64)}`, enabled: true, compatible: true }] }),
	read: async () => { throw new Error('Unexpected management read'); }, setEnabled: async () => { },
	readTextResource: async (reference, path, _signal, sessionId) => {
		skillResourceRequests.push([reference, path, sessionId]);
		if (path === 'SKILL.md') return '---\nname: review\ndescription: Review changes\n---\n[Guide](references/guide.md)';
		if (path === 'references/guide.md') return 'Reference guide.\n\n[Next](nested/checks.md)';
		if (path === 'references/nested/checks.md') return 'Nested reference.';
		throw new Error('Skill resource unavailable');
	},
}));
services.registerInstance(IPromptsService, prompts);
const promptContributions = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['chat.promptLanguageFeatures']));
promptContributions.advance(WorkbenchPhase.BlockStartup);
const fileContainer = document.createElement('section');
fileContainer.style.cssText = 'width:600px;height:140px';
fileContainer.setAttribute('aria-label', 'File editor');
document.body.append(fileContainer);
resources.add(services.get(ILanguageService).registerLanguage({ id: 'markdown' }));
resources.add(services.get(ILanguageService).registerLanguage({ id: 'typescript' }));
const promptFile = new URLSearchParams(location.search).has('prompt');
const fileModel = services.get(IModelService).createModel(promptFile ? '---\n\n---\nBody' : 'before after',
	services.get(ILanguageService).createById(promptFile ? 'markdown' : 'typescript'),
	URI.parse(promptFile ? 'inmemory://fixture/review/SKILL.md' : 'inmemory://fixture/file.ts'));
if (!(fileModel instanceof TextModel)) throw new TypeError('Expected the registered Stanza model');
resources.add(fileModel);
const file = resources.add(services.createInstance(CodeEditorWidget, {
	container: fileContainer, model: fileModel,
	contributions: promptFile ? EditorExtensionsRegistry.getSomeEditorContributions([SuggestController.ID, 'editor.contrib.hover', LinkDetector.ID]) : [],
}));
file.layout({ width: 600, height: 140 });
file.setSelection(promptFile ? new Selection(2, 1, 2, 1) : new Selection(1, 8, 1, 8));
let activeResource = fileModel.uri;
resources.add(services.get(ICodeEditorService).registerCodeEditorOpenHandler(async input => {
	if (input.resource.authority !== 'skill') return null;
	const reference = resources.add(await services.get(ITextModelService).createModelReference(input.resource));
	if (!(reference.object.textEditorModel instanceof TextModel)) throw new TypeError('Expected a resolved Stanza model');
	activeResource = input.resource;
	file.setModel(reference.object.textEditorModel);
	file.updateOptions({ readOnly: reference.object.isReadonly() !== false });
	file.focus();
	return file;
}));
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
services.registerInstance(ILayoutService, resources.add(new BrowserLayoutService({ root: document.body })));
const accessibleView = resources.add(services.createInstance(AccessibleViewService));
const list = resources.add(services.createInstance(ChatListWidget, root, {}));
list.setVisible(true);
const toolNotifications = resources.add(new Emitter<ServerNotification>());
const toolService = createAppServerAgentThreadService({ onNotification: listener => toolNotifications.event(listener) } as AppServerProtocolClient);
function receiveToolUpdate(params: TranscriptDto): ThreadTranscriptUpdateEnvelope {
	let latest: ThreadTranscriptUpdateEnvelope | undefined;
	using subscription = toolService.onDidUpdateThreadTranscript(update => { latest = update; });
	toolNotifications.fire({ method: 'session/thread/transcript/update', params });
	if (!latest) throw new Error('Expected an Agent Thread domain update');
	return latest;
}
const imageBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII='), character => character.charCodeAt(0));
let mediaRequests: unknown[] = [];
let delayMedia = false;
let completeMedia: (() => void) | undefined;
let mediaAborted = false;
services.registerInstance(IAgentThreadService, {
	...toolService,
	readAttachment: async (source, signal) => {
		mediaRequests.push(source);
		signal?.addEventListener('abort', () => { mediaAborted = true; }, { once: true });
		if (delayMedia) await new Promise<void>(resolve => { completeMedia = resolve; });
		if (source.itemId === 'audio') return { bytes: new Uint8Array(await (await fetch(toneWav)).arrayBuffer()), mimeType: 'audio/wav' };
		return { bytes: imageBytes, mimeType: 'image/png' };
	},
});
let mediaEntries: ThreadTranscriptEntry[] = [];
let toolEntries: ThreadTranscriptEntry[] = [];
let text = 'Reply with `inline`.\n\n```typescript\nconst code = "<safe>";\nsecond line\n```';
list.render([{ id: 'reply', type: 'agentMessage', text, transient: false }]);

declare global {
	interface Window {
		ashChatTranscriptIntegration: {
			state(): { copied: string; file: string; resource: string; editorCount: number; selection: unknown; notifications: readonly string[]; };
			openSkill(): Promise<void>;
			openReference(line: number, column: number): Promise<void>;
			skillRequests(): readonly unknown[];
			setFile(value: string, line: number, column: number): void;
			diagnostics(): readonly { message: string; code?: string | number; }[];
			setReadonly(value: boolean): void;
			setWrap(value: boolean): Promise<void>;
			setCodeLineHeight(height: number): Promise<void>;
			setTheme(value: 'dark' | 'light' | 'hc'): void;
			refresh(): void;
			stream(value: string, complete: boolean): void;
			showLongCode(): string;
			showTool(): void;
			openAccessibleView(help: boolean): boolean;
			updateTool(finish: boolean): void;
			showMedia(delay: boolean): void;
			refreshMedia(): void;
			finishMedia(): void;
			mediaState(): { requests: readonly unknown[]; aborted: boolean; };
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
	openSkill: async () => {
		const [skill] = await prompts.findAgentSkills(CancellationToken.None, 'reference-session');
		await services.get(ICodeEditorService).openCodeEditor({ resource: skill.uri }, file);
	},
	openReference: async (line, column) => { file.setSelection(new Selection(line, column, line, column)); file.focus(); await services.get(ICommandService).executeCommand('editor.action.openLink'); },
	skillRequests: () => skillResourceRequests,
	setFile: (value, line, column) => { fileModel.setValue(value); file.setSelection(new Selection(line, column, line, column)); },
	diagnostics: () => services.get(IMarkerService).read(fileModel.uri).map(marker => ({ message: marker.message, code: marker.code })),
	setReadonly: value => file.updateOptions({ readOnly: value }),
	setWrap: value => services.get(IConfigurationService).updateValue('chat.editor.wordWrap', value ? 'on' : 'off'),
	setCodeLineHeight: height => services.get(IConfigurationService).updateValue('chat.editor.lineHeight', height),
	setTheme: value => {
		const palette = value === 'dark' ? darkColorTheme : value === 'light' ? lightColorTheme : highContrastDarkColorTheme;
		theme.setColorTheme(palette);
	},
	stream: (value, complete) => list.render([{ id: 'stream', type: 'agentMessage', text: value, transient: !complete }]),
	refresh: () => list.render([{ id: 'reply', type: 'agentMessage', text, transient: false }]),
	showLongCode: () => {
		const code = Array.from({ length: 80 }, (_, index) => `const value${index} = ${index};`).join('\n');
		text = `\`\`\`typescript\n${code}\n\`\`\``;
		list.render([{ id: 'reply', type: 'agentMessage', text, transient: false }]);
		return code;
	},
	openAccessibleView: help => accessibleView.show(help ? AccessibleViewType.Help : AccessibleViewType.View),
	showTool: () => {
		const update = receiveToolUpdate({
			sessionId: 'session', threadId: 'thread', revision: 2, durableSequence: 1, changes: [{
				type: 'upsert', entry: {
					type: 'item', entryId: 'call', turnId: 'turn', transient: false, item: {
						type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'shell', name: 'shell', argumentsJson: '{"command":"echo <safe>"}',
						binding: { registryGeneration: 1, definitionDigest: 'digest', sourceChain: [{ type: 'product', component: 'shell' }], caller: { type: 'direct' }, activity: { type: 'command', program: 'echo', arguments: ['<safe>'], workingDirectory: '/remote/project' } },
					}
				}
			}]
		});
		toolEntries = update.changes.flatMap(change => change.type === 'upsert' ? [change.entry] : []);
		list.render(chatTranscriptListItems(toolEntries));
	},
	updateTool: finish => {
		const update = receiveToolUpdate({
			sessionId: 'session', threadId: 'thread', revision: finish ? 4 : 3, durableSequence: finish ? 2 : 1, changes: finish
				? [{ type: 'upsert', entry: { type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: { type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'shell', text: 'Denied <script>alert(1)</script>', isError: true } } }]
				: [{ type: 'upsert', entry: { type: 'toolOutput', entryId: 'stdout', turnId: 'turn', toolCallId: 'shell', stream: 'stdout', text: '<img src=x onerror=alert(1)>' } }, { type: 'upsert', entry: { type: 'toolOutput', entryId: 'stderr', turnId: 'turn', toolCallId: 'shell', stream: 'stderr', text: 'warning' } }],
		});
		toolEntries.push(...update.changes.flatMap(change => change.type === 'upsert' ? [change.entry] : []));
		list.render(chatTranscriptListItems(toolEntries));
	},
	showMedia: delay => {
		delayMedia = delay;
		mediaRequests = [];
		mediaAborted = false;
		const source = { sessionId: 'media-session', threadId: 'media-thread' };
		mediaEntries = [
			{ type: 'item', entryId: 'image', turnId: 'turn', transient: false, item: { type: 'userImageAttachment', itemId: 'image', turnId: 'turn', attachment: { contentDigest: 'sha256:image', mediaType: 'png', encodedBytes: imageBytes.length, width: 2, height: 1 } } },
			{ type: 'item', entryId: 'audio', turnId: 'turn', transient: false, item: { type: 'userAudioAttachment', itemId: 'audio', turnId: 'turn', attachment: { contentDigest: 'sha256:audio', mediaType: 'wav', encodedBytes: 32044, durationMs: 1000 } } },
			{ type: 'item', entryId: 'call', turnId: 'turn', transient: false, item: { type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'tool', name: 'image-tool', argumentsJson: '{}' } },
			{ type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: { type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'tool', text: 'Result', isError: false, content: [{ type: 'text', text: 'Result' }, { type: 'imageAttachment', detail: 'auto', attachment: { contentDigest: 'sha256:image', mediaType: 'png', encodedBytes: imageBytes.length, width: 2, height: 1 } }] } },
		];
		list.render(chatTranscriptListItems(mediaEntries, undefined, [], source));
	},
	refreshMedia: () => list.render(chatTranscriptListItems(mediaEntries, undefined, [], { sessionId: 'media-session', threadId: 'media-thread' })),
	finishMedia: () => completeMedia?.(),
	mediaState: () => ({ requests: mediaRequests, aborted: mediaAborted }),
	remove: () => list.render([]),
	dispose: () => resources.dispose(),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
