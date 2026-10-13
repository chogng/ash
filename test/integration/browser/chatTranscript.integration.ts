import { IWebviewService } from '../../../src/ash/workbench/contrib/webview/browser/webview.js';
import '../../../src/ash/workbench/contrib/webview/browser/webview.contribution.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
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
import { chatTranscriptListItems, type IChatListItem } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatListItems.js';
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
import { setNlsMessages } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';

const locale = new URLSearchParams(location.search).get('locale');
if (locale) {
	const catalog = productLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
	setNlsMessages(locale, catalog.bundles);
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
const prompts = resources.add(new PromptsService({
	onDidChangeSkills: Event.None,
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
const promptContributions = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['chat.promptLanguageFeatures', 'chatResponseResourceWorkbenchContribution']));
promptContributions.advance(WorkbenchPhase.BlockStartup);
const fileContainer = document.createElement('section');
fileContainer.style.cssText = 'width:600px;height:140px';
fileContainer.setAttribute('aria-label', 'File editor');
document.body.append(fileContainer);
resources.add(services.get(ILanguageService).registerLanguage({ id: 'markdown', extensions: ['.md'] }));
resources.add(services.get(ILanguageService).registerLanguage({ id: 'typescript', extensions: ['.ts'] }));
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
		if (input.resource.scheme === 'chat-response-resource') {
			const bytes = await services.get(IFileService).readFileBytes(input.resource);
			const model = services.get(IModelService).getModel(input.resource) ?? services.get(IModelService).createModel(new TextDecoder('utf-8', { fatal: true }).decode(bytes.bytes), services.get(ILanguageService).createByFilepathOrFirstLine(input.resource), input.resource);
			if (!(model instanceof TextModel)) throw new TypeError('Expected a resource model');
			file.setModel(model);
			file.updateOptions({ readOnly: input.readOnly });
			activeResource = input.resource;
			return;
		}
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
let imageReads = 0;
const listOptions = { imageResourceLoader: async () => { imageReads++; return new Blob([new Uint8Array(imageBytes)], { type: 'image/png' }); } };
let list = resources.add(services.createInstance(ChatListWidget, root, listOptions));
let rendererItems: readonly IChatListItem[] = [];
list.setVisible(true);
const toolNotifications = resources.add(new Emitter<ServerNotification>());
const appHtml = `<h1>Report</h1><output id="context"></output><output id="result"></output><output id="error"></output><button id="increment">Increment</button><button id="call">Call tool</button><output id="count">0</output>
<script>
let count = 0;
const rpc = message => parent.postMessage({jsonrpc:'2.0',...message}, '*');
window.addEventListener('message', event => {
  if (event.source !== parent) return;
  const message = event.data;
  if (message.id === 1 && message.result) {
    document.querySelector('#context').textContent = JSON.stringify(message.result.hostContext);
    rpc({method:'ui/notifications/initialized',params:{}});
    rpc({method:'ui/notifications/size-changed',params:{height:240}});
  } else if (message.method === 'ui/notifications/tool-result') {
    document.querySelector('#result').textContent = JSON.stringify(message.params);
  } else if (message.method === 'ui/notifications/host-context-changed') {
    document.querySelector('#context').textContent = JSON.stringify(message.params);
  } else if (message.error) document.querySelector('#error').textContent = JSON.stringify(message.error);
  else if (message.method === 'ui/resource-teardown') rpc({id:message.id,result:{}});
});
document.querySelector('#increment').onclick = () => { document.querySelector('#count').textContent = ++count; };
document.querySelector('#call').onclick = () => rpc({id:2,method:'tools/call',params:{name:'unexpected',arguments:{}}});
rpc({id:1,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'report',version:'1'},appCapabilities:{availableDisplayModes:['inline']}}});
</script>`;
let appRequests = false;
const appMessages: unknown[] = [];
const webviews = services.get(IWebviewService);
const observedViews = new Set<unknown>();
resources.add(webviews.onDidChangeActiveWebview(view => {
	if (view && !observedViews.has(view)) { observedViews.add(view); resources.add(view.onMessage(event => appMessages.push(event.message))); }
}));
let linkMode: 'read' | 'delay' | 'error' = 'read';
let linkRequests: { method: string; params: unknown; }[] = [];
let completeLink: (() => void) | undefined;
const linkBytes = new TextEncoder().encode('# Linked\r\n中文\r\n');
const toolService = createAppServerAgentThreadService({
	generation: 1,
	onNotification: (listener: (notification: ServerNotification) => void) => toolNotifications.event(listener),
	async request(definition: { method: string; }, params: unknown) {
		linkRequests.push({ method: definition.method, params });
		switch (definition.method) {
			case 'tool/resource/open': {
				if (linkMode === 'delay') await new Promise<void>(resolve => { completeLink = resolve; });
				if (linkMode === 'error') throw new Error('Resource origin retired');
				const bytes = appRequests ? new TextEncoder().encode(appHtml) : linkBytes;
				const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
				return { resourceId: 'linked', mimeType: appRequests ? 'text/html;profile=mcp-app' : 'text/markdown', size: bytes.length, sha256: `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}` };
			}
			case 'resource/read': { const bytes = appRequests ? new TextEncoder().encode(appHtml) : linkBytes; return { resourceId: 'linked', offset: 0, decodedLength: bytes.length, dataBase64: btoa(String.fromCharCode(...bytes)), eof: true }; }
			case 'resource/release': return null;
			case 'tool/resource/cancel': return null;
			default: throw new Error(`Unexpected ${definition.method}`);
		}
	},
} as unknown as AppServerProtocolClient);
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
			referenceReady(line: number, column: number): boolean;
			openReference(line: number, column: number): Promise<void>;
			skillRequests(): readonly unknown[];
			setFile(value: string, line: number, column: number): void;
			diagnostics(): readonly { message: string; code?: string | number; }[];
			setReadonly(value: boolean): void;
			setWrap(value: boolean): Promise<void>;
			setCodeLineHeight(height: number): Promise<void>;
			setTheme(value: 'dark' | 'light' | 'hc'): void;
			refresh(): void;
			imageReadCount(): number;
			renderItems(items: readonly IChatListItem[]): void;
			readingState(): ReturnType<ChatListWidget['getViewState']>;
			delayAttachments(value: boolean): void;
			setTranscriptVisible(value: boolean): void;
			recreateTranscript(): void;
			stream(value: string, complete: boolean): void;
			showLongCode(): string;
			showTool(): void;
			openAccessibleView(help: boolean): boolean;
			updateTool(finish: boolean): void;
			showMedia(delay: boolean): void;
			showArtifacts(revise: boolean): void;
			showLink(mode: 'read' | 'delay' | 'error'): void;
			showApp(): void;
			appState(): { messages: readonly unknown[]; views: number; };
			linkRequests(): readonly { method: string; params: unknown; }[];
			finishLink(): void;
			readResource(uri: string): Promise<number[]>;
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
	referenceReady: (line, column) => !!LinkDetector.get(file)?.getLinkOccurrence(new Selection(line, column, line, column).getPosition()),
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
	imageReadCount: () => imageReads,
	renderItems: items => { rendererItems = items; list.render(items); },
	readingState: () => list.getViewState(),
	delayAttachments: value => { delayMedia = value; },
	setTranscriptVisible: value => {
		if (!value) list.setVisible(false);
		root.style.display = value ? 'flex' : 'none';
		if (value) list.setVisible(true);
	},
	recreateTranscript: () => {
		const previous = list;
		const state = previous.getViewState();
		list = resources.add(services.createInstance(ChatListWidget, root, listOptions));
		previous.element.replaceWith(list.element);
		list.restoreViewState(state, rendererItems);
		previous.dispose();
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
	linkRequests: () => linkRequests,
	finishLink: () => completeLink?.(),
	appState: () => ({ messages: appMessages, views: [...webviews.webviews].length }),
	showApp: () => {
		appRequests = true;
		linkMode = 'read';
		linkRequests = [];
		const update = receiveToolUpdate({
			sessionId: 'app-session', threadId: 'app-thread', revision: 2, durableSequence: 1, changes: [
				{ type: 'upsert', entry: { type: 'item', entryId: 'app-call', turnId: 'turn', transient: false, item: { type: 'toolCall', itemId: 'app-call', turnId: 'turn', toolCallId: 'report', name: 'report', argumentsJson: '{"value":7}' } } },
				{
					type: 'upsert', entry: {
						type: 'item', entryId: 'app-result', turnId: 'turn', transient: false, item: {
							type: 'toolResult', itemId: 'app-result', turnId: 'turn', toolCallId: 'report', text: 'Report ready', isError: false, content: [
								{ type: 'text', text: 'Report ready' },
								{ type: 'artifact', artifact: { source: { type: 'structuredResult' }, mimeType: 'application/json', data: { type: 'json', json: '{"value":7}' }, contentDigest: 'sha256:result', truncated: false } },
								{ type: 'artifact', artifact: { source: { type: 'mcpApp', uri: 'ui://report' }, mimeType: 'text/html;profile=mcp-app', data: { type: 'json', json: '{"viewOnly":"metadata"}' }, contentDigest: 'sha256:app', truncated: false } },
							]
						}
					}
				},
			]
		});
		list.render(chatTranscriptListItems(update.changes.flatMap(change => change.type === 'upsert' ? [change.entry] : []), undefined, [], { sessionId: update.sessionId, threadId: update.threadId }));
	},
	showLink: mode => {
		appRequests = false;
		linkMode = mode;
		linkRequests = [];
		const update = receiveToolUpdate({
			sessionId: 'link-session', threadId: 'link-thread', revision: 2, durableSequence: 1, changes: [
				{ type: 'upsert', entry: { type: 'item', entryId: 'linked-result', turnId: 'link-turn', transient: false, item: { type: 'toolResult', itemId: 'linked-result', turnId: 'link-turn', toolCallId: 'documents', text: '', isError: false, content: [{ type: 'artifact', artifact: { source: { type: 'resourceLink', uri: 'file:///server/report.md' }, mimeType: 'text/markdown', data: { type: 'json', json: '{"name":"report.md","description":"Read from the original server"}' }, contentDigest: 'sha256:link', truncated: false } }] } } },
			]
		});
		list.render(chatTranscriptListItems(update.changes.flatMap(change => change.type === 'upsert' ? [change.entry] : []), undefined, [], { sessionId: update.sessionId, threadId: update.threadId }));
	},
	readResource: async uri => [...(await services.get(IFileService).readFileBytes(URI.parse(uri))).bytes],
	showArtifacts: revise => {
		const update = receiveToolUpdate({
			sessionId: 'resource-session', threadId: 'resource-thread', revision: revise ? 3 : 2, durableSequence: 2, changes: [
				{ type: 'upsert', entry: { type: 'item', entryId: 'call', turnId: 'turn', transient: false, item: { type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'resources', name: 'resources', argumentsJson: '{}' } } },
				{
					type: 'upsert', entry: {
						type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: {
							type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'resources', text: 'Legacy fallback', isError: false, content: [
								{ type: 'artifact', artifact: { source: { type: 'embeddedResource', uri: 'file:///untrusted/report.md' }, mimeType: 'text/markdown', data: { type: 'text', text: revise ? 'Changed truncated resource' : '<script>window.compromised = true</script>\r\n中文' }, contentDigest: revise ? 'sha256:revised' : 'sha256:text', truncated: revise } },
								{ type: 'artifact', artifact: { source: { type: 'structuredResult' }, mimeType: 'application/json', data: { type: 'json', json: '{"amount":1.0,"text":"<img src=x onerror=alert(1)>"}' }, contentDigest: 'sha256:json', truncated: false } },
								{ type: 'artifact', artifact: { source: { type: 'embeddedResource', uri: 'mcp://data/blob.bin' }, mimeType: 'application/octet-stream', data: { type: 'binary', bytes: [0, 127, 255] }, contentDigest: 'sha256:bytes', truncated: false } },
							]
						}
					}
				},
			]
		});
		list.render(chatTranscriptListItems(update.changes.flatMap(change => change.type === 'upsert' ? [change.entry] : []), undefined, [], { sessionId: update.sessionId, threadId: update.threadId }));
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
