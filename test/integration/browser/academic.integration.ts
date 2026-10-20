import { bindTestColorTheme } from './themeFixture.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { highContrastDarkColorTheme, highContrastLightColorTheme, lightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import type { IDocumentCollaborationApi } from '../../../src/ash/platform/collaboration/common/documentCollaborationApi.js';
import { generalProfile, createEditorProfileConfiguration } from '../../../extensions/academic/browser/generalProfile.js';
import { documentContributions } from '../../../extensions/academic/browser/documentContributions.js';
import { DocumentTextModel } from '../../../extensions/academic/common/model/documentTextModel.js';
import { MainThreadClientEditors } from '../../../src/ash/workbench/api/browser/mainThreadClientEditors.js';
import { loadExtensionEditorModule } from '../../../src/ash/workbench/services/extensions/browser/extensionEditorModules.js';
import { IExtensionApi, normalizeExtensionCatalog } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { ExtensionResourceLoaderService } from '../../../src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot } from '../../../src/ash/platform/agentHost/common/extensionHostApi.js';
import { TestUriIdentityServices } from '../../../src/ash/platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { StandaloneCommandService } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { IDocumentEditorTextModelService } from '../../../src/ash/workbench/services/documentEditor/common/documentTypes.js';
import { DocumentEditorTextModelService } from '../../../src/ash/workbench/services/documentEditor/browser/documentEditorTextModelService.js';
import { BrowserWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import type { ITextFileService } from '../../../src/ash/workbench/services/textfile/common/textfiles.js';
import type { TextFileResolveRequest, TextFileSaveRequest } from '../../../src/ash/workbench/services/textfile/common/textFileService.js';
import { URI } from "../../../src/ash/base/common/uri.js";
import { Emitter, Event } from "../../../src/ash/base/common/event.js";
import { Disposable, DisposableStore } from "../../../src/ash/base/common/lifecycle.js";
import '../../../src/ash/base/browser/ui/dialog/dialog.css';
import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/base/browser/ui/inputbox/inputbox.css';
import { createDefaultDocumentSchema } from "../../../extensions/academic/common/model/documentSchema.js";
import { createTextNode } from "../../../extensions/academic/common/model/document.js";

import { DocumentEditorPane } from "../../../src/ash/workbench/contrib/documentEditor/browser/documentEditorPane.js";
import type { DocumentNode } from "../../../extensions/academic/common/model/document.js";
import { documentFromPlainText, serializeDocument } from "../../../extensions/academic/common/model/documentSerialization.js";
import type { DocumentSchema } from "../../../extensions/academic/common/model/documentSchema.js";
import type { DocumentCollaborationRoom } from "../../../src/ash/workbench/services/documentCollaboration/common/documentCollaborationService.js";
import type { DocumentCollaborationInvite } from "../../../src/ash/workbench/services/documentCollaboration/common/documentCollaborationService.js";
import type { DocumentCollaborationMember } from "../../../src/ash/workbench/services/documentCollaboration/common/documentCollaborationService.js";
import type { DocumentCollaborationOpenInput } from "../../../src/ash/workbench/services/documentCollaboration/common/documentCollaborationService.js";
import type { DocumentCollaborationPresence } from "../../../extensions/academic/common/services/documentCollaborationService.js";
import type { DocumentCollaborationRoomRole } from "../../../src/ash/workbench/services/documentCollaboration/common/documentCollaborationService.js";
import type { DocumentSelection } from "../../../extensions/academic/common/core/documentSelection.js";
import type { DocumentCollaborationSnapshot } from "../../../extensions/academic/common/services/documentCollaborationService.js";
import type { DocumentCollaborationRemoteEnvelope } from "../../../extensions/academic/common/services/documentCollaborationService.js";
import type { DocumentCollaborationEnvelope } from "../../../extensions/academic/common/services/documentCollaborationService.js";
import type { DocumentCollaborationSubmitOutcome } from "../../../extensions/academic/common/services/documentCollaborationService.js";
import type { IDocumentCollaborationService } from "../../../src/ash/workbench/services/documentCollaboration/common/documentCollaborationService.js";
import { MemoryTextFiles } from "./memoryTextFiles.js";
import { EditorExtensionsRegistry } from '../../../src/ash/editor/browser/editorExtensions.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { OpenerService } from '../../../src/ash/editor/browser/services/openerService.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../../src/ash/editor/standalone/browser/standaloneCodeEditorService.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import messages from '../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import editorMessages from '../../../extensions/language-pack-zh-cn/translations/editor.json' with { type: 'json' };
import { withEnabledBuiltInExtensions } from '../../../src/ash/platform/extensions/browser/extensionApi.js';
import { GlobalExtensionEnablementService } from '../../../src/ash/platform/extensionManagement/common/extensionEnablementService.js';
import { AppServerExtensionService } from '../../../src/ash/workbench/services/extensions/browser/appServerExtensionService.js';
import { createEmptyTestLanguagePacks } from '../../../src/ash/workbench/services/localization/test/common/localizationTestUtils.js';
import { AdapterManager } from '../../../src/ash/workbench/contrib/debug/browser/debugAdapterManager.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import { DocumentTypes } from '../../../src/ash/workbench/services/documentEditor/common/documentTypes.js';
import { toDisposable } from '../../../src/ash/base/common/lifecycle.js';

import { CallViewPane } from '../../../src/ash/workbench/contrib/call/browser/callViewPane.js';
import '../../../src/ash/workbench/contrib/call/browser/media/call.css';
import type { ICallService, CallDocument, CallState } from '../../../src/ash/platform/call/common/callService.js';
import type { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import type { IEditorPane, IResourceEditorInput } from '../../../src/ash/workbench/common/editor.js';
import { emptyEditorServiceState } from '../../../src/ash/workbench/test/common/testEditorService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { GENERAL_DOCUMENT_EDITOR_ID } from '../../../src/ash/workbench/contrib/documentEditor/browser/documentEditorInput.js';

interface AcademicIntegrationHarness {
	getCallDocumentState(): { documents: readonly CallDocument[]; originalDirty: boolean; joinedResource: string | undefined; joinedTexts: readonly string[]; };
	readonly apiDocumentType: string;
	getBundleIds(): readonly string[];
	getCodeBlockText(): string | undefined;
	getStructuredBlockTexts(): readonly string[];
	getStructuredFirstTextMarks(): readonly { readonly type: string; readonly attrs: Readonly<Record<string, string | number | boolean | null>>; }[];
	getStructuredSelection(): unknown;
	getOpenedLinks(): readonly string[];
	saveCodeBlock(): Promise<void>;
	getSavedCodeBlock(): string;
	setAcademicEnabled(enabled: boolean): Promise<void>;
	replaceAcademicPackage(): Promise<void>;
	getAcademicRegistration(): { name: string | undefined; routed: boolean; };
	saveStructured(): Promise<void>;
	getSavedStructured(): string;
	setExternalStructured(text: string): Promise<void>;
	revertStructured(): Promise<void>;
	reopenStructured(): Promise<void>;
	getStructuredDirty(): boolean;
	getStructuredBackup(): string;
	getStructuredCollaborationSubmissions(): readonly string[];
	restoreStructuredBackup(text: string): void;
	dispose(): void;
}

declare global {
	interface Window {
		ashAcademicIntegration: AcademicIntegrationHarness;
	}
}

const collaborationDocuments = new Map<string, DocumentNode>();

class BrowserDocumentCollaborationService extends Disposable implements IDocumentCollaborationService {
	async open(input: DocumentCollaborationOpenInput, _signal: AbortSignal): Promise<DocumentCollaborationRoom> {
		const roomId = input.roomId ?? 'editor-browser-room';
		const document = collaborationDocuments.get(roomId) ?? input.document;
		collaborationDocuments.set(roomId, document);
		return new BrowserDocumentCollaborationConnection(schema, input.clientId, document, roomId, true);
	}
}

class BrowserDocumentCollaborationConnection extends Disposable implements DocumentCollaborationRoom {
	private readonly updates = this._register(new Emitter<DocumentCollaborationRemoteEnvelope>());
	private readonly snapshots = this._register(new Emitter<DocumentCollaborationSnapshot>());
	private readonly presences = this._register(new Emitter<readonly DocumentCollaborationPresence[]>());
	private readonly failures = this._register(new Emitter<Error>());
	private version = 0;

	readonly initialSnapshot;
	readonly canEdit = true;
	readonly serverUrl = 'https://documents.example';
	readonly principalId: string | undefined;
	readonly onDidReceiveUpdate: Event<DocumentCollaborationRemoteEnvelope> = this.updates.event;
	readonly onDidReceiveSnapshot: Event<DocumentCollaborationSnapshot> = this.snapshots.event;
	readonly onDidReceivePresence: Event<readonly DocumentCollaborationPresence[]> = this.presences.event;
	readonly onDidFail: Event<Error> = this.failures.event;
	readonly currentPresence: readonly DocumentCollaborationPresence[] = [];

	constructor(readonly schema: DocumentSchema, readonly clientId: string, document: DocumentNode, readonly roomId: string, readonly canManageMembers: boolean) {
		super();
		this.principalId = canManageMembers ? "browser-owner" : undefined;
		this.initialSnapshot = Object.freeze({ roomId, version: this.version, document });
	}

	async submit(envelope: DocumentCollaborationEnvelope, _document: DocumentNode, _signal: AbortSignal): Promise<DocumentCollaborationSubmitOutcome> {
		this.version += 1;
		collaborationDocuments.set(this.roomId, _document);
		return {
			kind: "accepted",
			update: {
				clientId: this.clientId,
				sequence: envelope.sequence,
				baseVersion: envelope.baseVersion,
				version: this.version,
				transaction: envelope.transaction,
			},
		};
	}

	async updatePresence(_selection: DocumentSelection | undefined, _signal: AbortSignal): Promise<void> { }

	async createInvite(displayName: string, role: DocumentCollaborationRoomRole, _signal: AbortSignal): Promise<DocumentCollaborationInvite> {
		if (!this.canManageMembers) throw new Error("This collaboration member cannot create room invitations");
		return Object.freeze({ roomId: this.roomId, principalId: "browser-member", displayName, role, accessToken: "editor-browser-member-token" });
	}

	async listMembers(_signal: AbortSignal): Promise<readonly DocumentCollaborationMember[]> {
		if (!this.canManageMembers) throw new Error("This collaboration member cannot inspect room members");
		return Object.freeze([
			Object.freeze({ principalId: "browser-owner", displayName: "Browser owner", role: "owner" }),
			Object.freeze({ principalId: "browser-member", displayName: "Writer", role: "editor" }),
		]);
	}

	async rotateMemberAccessToken(principalId: string, _signal: AbortSignal): Promise<DocumentCollaborationInvite> {
		if (!this.canManageMembers) throw new Error("This collaboration member cannot manage room credentials");
		return Object.freeze({ roomId: this.roomId, principalId, displayName: principalId === "browser-owner" ? "Browser owner" : "Writer", role: principalId === "browser-owner" ? "owner" : "editor", accessToken: "editor-browser-rotated-token" });
	}

	async revokeMember(_principalId: string, _signal: AbortSignal): Promise<void> {
		if (!this.canManageMembers) throw new Error("This collaboration member cannot manage room credentials");
	}
}

if (new URLSearchParams(location.search).get('locale') === 'zh-CN') { setNlsMessages('zh-CN', { ...messages, ...editorMessages, ash: { ...messages.ash, ...editorMessages.ash } }); }
const schema = createDefaultDocumentSchema();
const generalDocument = new URLSearchParams(location.search).has('generalDocument');
if (generalDocument) await import('../../../src/ash/workbench/contrib/documentEditor/browser/documentEditor.contribution.js');
const apiDocument = schema.createDocument([schema.createNode("paragraph", { content: [schema.createText("editor-api")] })]);
const apiModel = DocumentTextModel.create(schema, apiDocument);
const codeBlockResource = URI.parse("inmemory://editor/code-block.ash-academic");
const structuredResource = URI.parse(generalDocument ? 'inmemory://editor/document.ash-doc' : 'inmemory://editor/document.ash-academic');
const codeBlockDocument = schema.createDocument([schema.createNode("codeBlock", {
	attrs: { language: "typescript" },
	content: [createTextNode("editor-text", "const editor = 1;")],
	id: "editor-code-block",
})], "editor-text-document");
const codeBlockFiles = new MemoryTextFiles(codeBlockResource, serializeDocument(codeBlockDocument, schema));
const m6Paragraph = (id: string, text: string) => schema.createNode('paragraph', { id, content: [schema.createText(text, { id: `${id}-text` })] });
const structuredDocument = new URLSearchParams(location.search).has('m6Document')
	? schema.createDocument([
		schema.createNode('paragraph', { id: 'm6-first', content: [schema.createText('Hel', { id: 'm6-a', marks: [{ type: 'strong', attrs: {} }] }), schema.createText('lo Hello', { id: 'm6-b', marks: [{ type: 'em', attrs: {} }] })] }),
		schema.createNode('orderedList', { id: 'm6-list', content: [schema.createNode('listItem', { content: [m6Paragraph('m6-item', 'Hello item')] })] }),
		schema.createNode('table', { content: [schema.createNode('tableRow', { content: [schema.createNode('tableCell', { content: [m6Paragraph('m6-cell', 'Hello cell')] })] })] }),
		schema.createNode('codeBlock', { id: 'm6-code', content: [schema.createText('Hello code', { id: 'm6-code-text' })] }),
	])
	: new URLSearchParams(location.search).has('richParagraphs')
		? schema.createDocument(['Title', 'Body'].map(text => schema.createNode('paragraph', { content: [schema.createText(text, { marks: [{ type: 'strong', attrs: {} }] })] })))
		: documentFromPlainText(schema, "Title\nBody");
// Extension scenarios open a legacy Academic file and must save it as typed v2.
const structuredText = new URLSearchParams(location.search).has('academicExtension')
	? JSON.stringify({ format: 'ash.document', version: 1, document: structuredDocument })
	: serializeDocument(structuredDocument, schema);
const structuredFiles = new MemoryTextFiles(structuredResource, structuredText);
const collaborationSubmissions: string[] = [];
// This fixture supplies the server's JSON boundary; the production adapter and package codec
// still serialize, validate and deserialize every acknowledgement into the active factory.
const documentCollaborationApi: IDocumentCollaborationApi = {
	open: async request => ({ clientId: request.clientId, schemaId: request.schemaId, snapshot: { roomId: request.roomId ?? 'restart-room', version: 0, document: request.document } }),
	submit: async request => {
		collaborationSubmissions.push(request.transaction);
		return { status: 'accepted', update: { roomId: request.roomId, clientId: request.clientId, sequence: request.sequence, baseVersion: request.baseVersion, version: request.baseVersion + 1, transaction: request.transaction } };
	},
	publishPresence: async request => ({ roomId: request.roomId, generation: 0, presences: [] }),
	readPresence: async request => ({ roomId: request.roomId, generation: 0, presences: [] }),
};
const serverEvents = { subscribe: () => ({ dispose() { } }) };
const disposables = new DisposableStore();
const uriIdentityServices = disposables.add(new TestUriIdentityServices());
const services = disposables.add(new InstantiationService());
const dialogs = disposables.add(new DialogService());
services.registerInstance(IDialogService, dialogs);
services.registerInstance(ICodeEditorService, disposables.add(new StandaloneCodeEditorService()));
services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
const openedLinks: string[] = [];
const opener = disposables.add(services.createInstance(OpenerService));
services.registerInstance(IOpenerService, opener);
disposables.add(opener.registerExternalOpener({ openExternal: async href => { openedLinks.push(href); return true; } }));
disposables.add(new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(document.body)));
const copies = disposables.add(uriIdentityServices.createInstance(BrowserWorkingCopyService));
const files: ITextFileService = {
	onDidChangeFiles: codeBlockFiles.onDidChangeFiles,
	onDidSave: Event.any(codeBlockFiles.onDidSave, structuredFiles.onDidSave),
	resolve: (request: TextFileResolveRequest, signal: AbortSignal) => (request.resource.toString() === codeBlockResource.toString() ? codeBlockFiles : structuredFiles).resolve(request, signal),
	save: (request: TextFileSaveRequest, signal: AbortSignal) => (request.resource.toString() === codeBlockResource.toString() ? codeBlockFiles : structuredFiles).save(request, signal),
};
services.registerInstance(IDocumentEditorTextModelService, disposables.add(new DocumentEditorTextModelService(files, copies)));
if (new URLSearchParams(location.search).has('m6Document')) services.registerInstance(IThemeService, disposables.add(new TestThemeService(new URLSearchParams(location.search).has('hc') ? highContrastDarkColorTheme : new URLSearchParams(location.search).has('hcLight') ? highContrastLightColorTheme : lightColorTheme)));
registerTestComponentServices(services);
if (new URLSearchParams(location.search).has('m6Document')) disposables.add(bindTestColorTheme(services.get(IThemeService), document.documentElement));
const codeBlockPane = disposables.add(services.createInstance(DocumentEditorPane, { ...createEditorProfileConfiguration(schema, { outlineNavigator: false, contributions: documentContributions }), contentType: 'application/vnd.ash.document+json' }));
let academicExtensionService: MainThreadClientEditors | undefined;
let academicSnapshot: ExtensionHostFleetSnapshot | undefined;
let academicEnablement: GlobalExtensionEnablementService | undefined;
if (new URLSearchParams(location.search).has('academicExtension') || generalDocument) {
	const fixture: IExtensionApi = {
		list: async () => {
			const response = await fetch('/__academy_catalog');
			if (!response.ok) throw new Error('Academy package catalog unavailable');
			return normalizeExtensionCatalog(await response.json());
		},
		resources: new ExtensionResourceLoaderService(async request => {
			const response = await fetch(`/__academy_resource?generation=${request.generation}&extensionId=${encodeURIComponent(request.extensionId)}&path=${encodeURIComponent(request.path)}`);
			if (!response.ok) throw new Error('Academy package resource unavailable');
			return new Uint8Array(await response.arrayBuffer());
		}),
	};
	academicEnablement = disposables.add(services.createInstance(GlobalExtensionEnablementService));
	const api = withEnabledBuiltInExtensions({
		list: async () => {
			const catalog = await fixture.list('cached');
			return { ...catalog, extensions: catalog.extensions.filter(entry => entry.id === 'ash.academic') };
		},
		resources: fixture.resources,
	}, academicEnablement);
	const locale = new URLSearchParams(location.search).get('locale') ?? 'en';
	services.registerInstance(IExtensionApi, api);
	services.registerInstance(IExtensionHostApi, {
		invoke: async (request, signal) => {
			const response = await fetch(`/__academy_invoke?locale=${locale}`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.payload) });
			if (!response.ok) throw new Error('Academy provider invocation failed');
			return response.json();
		},
	} as IExtensionHostApi);
	academicExtensionService = disposables.add(services.createInstance(MainThreadClientEditors, 30_000, loadExtensionEditorModule));
	const response = await fetch(`/__academy_extension?locale=${locale}`);
	if (!response.ok) throw new Error('Academy provider unavailable');
	academicSnapshot = await response.json();
	await academicExtensionService.update(academicSnapshot!);
}
let structuredPane = disposables.add(academicExtensionService
	? await EditorPanes.getEditorPane({ resource: structuredResource })!.create({ input: { resource: structuredResource }, instantiationService: services, documentCollaborationApi, serverEvents }) as DocumentEditorPane
	: generalDocument
		? EditorPanes.getEditorPane({ resource: structuredResource }, { preferredEditorId: GENERAL_DOCUMENT_EDITOR_ID })!.create({ input: { resource: structuredResource }, instantiationService: services, documentCollaborationApi, serverEvents }) as DocumentEditorPane
		: services.createInstance(DocumentEditorPane, { ...createEditorProfileConfiguration(schema, { outlineNavigator: false, contributions: documentContributions }), contentType: 'application/vnd.ash.document+json', createDocumentCollaborationService: () => new BrowserDocumentCollaborationService() }));

codeBlockPane.create(requiredElement("#code-block"));
structuredPane.create(requiredElement("#document-editor"));
codeBlockPane.layout({ width: 900, height: 300 });
structuredPane.layout({ width: 900, height: 300 });
await codeBlockPane.setInput({ resource: codeBlockResource, label: "snippet.ts" }, new AbortController().signal);
await structuredPane.setInput({ resource: structuredResource, label: "paper", readOnly: new URLSearchParams(location.search).has('readOnly') }, new AbortController().signal);

let callDocuments: readonly CallDocument[] = [];
let joinedDocumentPane: DocumentEditorPane | undefined;
if (new URLSearchParams(location.search).has('callDocuments')) {
	services.registerInstance(IConfigurationService, disposables.add(new InMemoryConfigurationService()));
	const changes = disposables.add(new Emitter<void>());
	const activeState = (): CallState => ({ connection: 'connected', muted: true, deafened: false, microphoneAllowed: true, canManage: true, screenSharing: false, screenAllowed: true, participants: [], documents: callDocuments, error: null });
	const calls: ICallService = {
		onDidChange: changes.event, onDidChangeScreens: Event.None, screens: [], screenError: undefined,
		get state() { return activeState(); },
		start: async () => { }, mute: async () => { }, deafen: async () => { }, selectDevice: async () => { },
		screenSources: async () => [], shareScreen: async () => { }, stopScreenShare: async () => { },
		invite: async () => ({ url: '', credential: '' }), leave: async () => { }, end: async () => { },
		shareDocument: async document => { callDocuments = [document]; changes.fire(); },
		unshareDocument: async () => { callDocuments = []; changes.fire(); },
	};
	let activeInput: IResourceEditorInput = { resource: structuredResource, label: 'Paper' };
	const panes: IEditorPane[] = [structuredPane];
	const editors: IEditorService = {
		...emptyEditorServiceState,
		get activeEditor() { return activeInput; },
		get visibleEditorPanes() { return panes; },
		openEditor: async input => {
			const container = document.createElement('section');
			container.id = 'call-document-editor';
			document.body.append(container);
			disposables.add(toDisposable(() => container.remove()));
			joinedDocumentPane = disposables.add(services.createInstance(DocumentEditorPane, { ...createEditorProfileConfiguration(schema, { outlineNavigator: false, contributions: documentContributions }), contentType: input.contentType!, createDocumentCollaborationService: () => new BrowserDocumentCollaborationService() }));
			joinedDocumentPane.create(container);
			joinedDocumentPane.layout({ width: 900, height: 300 });
			await joinedDocumentPane.setInput(input, new AbortController().signal);
			panes.push(joinedDocumentPane);
			activeInput = input;
		},
		focusActiveEditor: () => joinedDocumentPane?.focus(),
	};
	const types = disposables.add(DocumentTypes.registerTypes());
	types.replace([{ id: 'call-document', contentType: 'application/vnd.ash.document+json', extensions: ['.ashdoc'] }]);
	const container = document.createElement('section');
	container.id = 'call-view';
	document.body.append(container);
	const callPane = disposables.add(new CallViewPane(container, { id: 'call-fixture', title: 'Calls' }, calls, services.get(IConfigurationService), editors));
	callPane.setVisible(true);
	callPane.layout(400, 0, 900);
}

window.ashAcademicIntegration = {
	getCallDocumentState: () => ({ documents: callDocuments, originalDirty: structuredPane.isDirty, joinedResource: joinedDocumentPane?.workingCopy?.resource.scheme, joinedTexts: joinedDocumentPane?.getDocument().content.map(block => block.content.find(child => child.text !== undefined)?.text ?? '') ?? [] }),
	apiDocumentType: apiModel.document.type,
	getBundleIds: () => EditorExtensionsRegistry.getEditorContributions().map(contribution => contribution.id),
	getCodeBlockText: () => codeBlockPane.getDocument().content[0]?.content[0]?.text,
	getStructuredBlockTexts: () => structuredPane.getDocument().content.map(block => block.content.find(child => child.text !== undefined)?.text ?? ""),
	getStructuredFirstTextMarks: () => structuredPane.getDocument().content[0]?.content[0]?.marks ?? [],
	getStructuredSelection: () => structuredPane.getDocumentSelection(),
	getOpenedLinks: () => openedLinks,
	saveCodeBlock: () => codeBlockPane.save(),
	getSavedCodeBlock: () => codeBlockFiles.read(codeBlockResource),
	setAcademicEnabled: async enabled => {
		if (!academicExtensionService || !academicEnablement) throw new Error('Academic extension fixture is not enabled');
		if (enabled) await academicEnablement.enableExtension({ id: 'ash.academic' });
		else await academicEnablement.disableExtension({ id: 'ash.academic' });
		const locale = new URLSearchParams(location.search).get('locale') ?? 'en';
		const response = await fetch(`/__academy_extension?locale=${locale}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
		if (!response.ok) throw new Error('Academy provider lifecycle failed');
		academicSnapshot = await response.json();
		await academicExtensionService.update(academicSnapshot!);
	},
	replaceAcademicPackage: async () => {
		if (!academicExtensionService) throw new Error('Academic extension fixture is not enabled');
		const locale = new URLSearchParams(location.search).get('locale') ?? 'en';
		const response = await fetch(`/__academy_extension?locale=${locale}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, replace: true }) });
		if (!response.ok) throw new Error('Academy package replacement failed');
		academicSnapshot = await response.json();
		await academicExtensionService.update(academicSnapshot!);
	},
	getAcademicRegistration: () => ({
		name: EditorPanes.getEditorPanes().find(pane => pane.id === (generalDocument ? GENERAL_DOCUMENT_EDITOR_ID : 'stanza.editor.document'))?.name,
		routed: DocumentTypes.find({ resource: structuredResource }) !== undefined,
	}),
	saveStructured: () => structuredPane.save(),
	getSavedStructured: () => structuredFiles.read(structuredResource),
	setExternalStructured: async text => { await structuredFiles.save({ resource: structuredResource, text }, new AbortController().signal); },
	revertStructured: () => structuredPane.revert(),
	reopenStructured: async () => {
		if (academicExtensionService) {
			const previous = structuredPane;
			const next = await EditorPanes.getEditorPane({ resource: structuredResource })!.create({ input: { resource: structuredResource }, instantiationService: services, documentCollaborationApi, serverEvents }) as DocumentEditorPane;
			try {
				next.create(requiredElement('#document-editor'));
				await next.setInput({ resource: structuredResource, label: 'paper' }, new AbortController().signal);
				next.layout({ width: 900, height: 600 });
				structuredPane = disposables.add(next);
				previous.dispose();
			} catch (error) { next.dispose(); throw error; }
		} else {
			structuredPane.clearInput();
			await structuredPane.setInput({ resource: structuredResource, label: 'paper' }, new AbortController().signal);
		}
	},
	getStructuredDirty: () => structuredPane.isDirty,
	getStructuredBackup: () => structuredPane.workingCopy!.backup(),
	getStructuredCollaborationSubmissions: () => [...collaborationSubmissions],
	restoreStructuredBackup: text => structuredPane.workingCopy!.restoreBackup(text),
	dispose: () => {
		apiModel.dispose();
		disposables.dispose();
		codeBlockFiles.dispose();
		structuredFiles.dispose();
	},
};

function requiredElement(selector: string): HTMLElement {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) throw new Error(`Missing editor integration root '${selector}'`);
	return element;
}
