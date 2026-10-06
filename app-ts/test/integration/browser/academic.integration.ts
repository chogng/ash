import { registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { StandaloneCommandService } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { IDocumentEditorTextModelService } from '../../../src/ash/workbench/services/documentEditor/common/documentTypes.js';
import { DocumentEditorTextModelService } from '../../../src/ash/workbench/services/documentEditor/browser/documentEditorTextModelService.js';
import { BrowserWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import type { TextFileResolveRequest, TextFileSaveRequest } from '../../../src/ash/workbench/services/textfile/common/textFileService.js';
import { URI } from "../../../src/ash/base/common/uri.js";
import { Emitter, type Event } from "../../../src/ash/base/common/event.js";
import { Disposable, DisposableStore } from "../../../src/ash/base/common/lifecycle.js";
import '../../../src/ash/base/browser/ui/dialog/dialog.css';
import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/base/browser/ui/inputbox/inputbox.css';
import { createDefaultDocumentSchema } from "../../../src/ash/editor/editor.api.js";
import { createTextNode } from "../../../src/ash/editor/editor.api.js";
import { TextModel } from "../../../src/ash/editor/editor.api.js";
import "../../../src/ash/editor/contrib/documentEditor.contribution.js";
import { DocumentEditorPane } from "../../../src/ash/workbench/contrib/documentEditor/browser/documentEditorPane.js";
import type { DocumentNode } from "../../../src/ash/editor/common/model/document.js";
import { documentFromPlainText, serializeDocument } from "../../../src/ash/editor/common/model/documentSerialization.js";
import type { DocumentSchema } from "../../../src/ash/editor/common/model/documentSchema.js";
import type { DocumentCollaborationRoom } from "../../../src/ash/workbench/services/documentCollaboration/common/documentCollaborationService.js";
import type { DocumentCollaborationInvite } from "../../../src/ash/workbench/services/documentCollaboration/common/documentCollaborationService.js";
import type { DocumentCollaborationMember } from "../../../src/ash/workbench/services/documentCollaboration/common/documentCollaborationService.js";
import type { DocumentCollaborationOpenInput } from "../../../src/ash/workbench/services/documentCollaboration/common/documentCollaborationService.js";
import type { DocumentCollaborationPresence } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationRoomRole } from "../../../src/ash/workbench/services/documentCollaboration/common/documentCollaborationService.js";
import type { DocumentSelection } from "../../../src/ash/editor/common/core/documentSelection.js";
import type { DocumentCollaborationSnapshot } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationRemoteEnvelope } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationEnvelope } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationSubmitOutcome } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
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
import messages from '../../../localization/zh-CN/workbench.json' with { type: 'json' };

interface AcademicIntegrationHarness {
	readonly apiDocumentType: string;
	getBundleIds(): readonly string[];
	getCodeBlockText(): string | undefined;
	getStructuredBlockTexts(): readonly string[];
	getStructuredFirstTextMarks(): readonly { readonly type: string; readonly attrs: Readonly<Record<string, string | number | boolean | null>>; }[];
	getStructuredSelection(): unknown;
	getOpenedLinks(): readonly string[];
	saveCodeBlock(): Promise<void>;
	getSavedCodeBlock(): string;
	dispose(): void;
}

declare global {
	interface Window {
		ashAcademicIntegration: AcademicIntegrationHarness;
	}
}

class BrowserDocumentCollaborationService extends Disposable implements IDocumentCollaborationService {
	async open(input: DocumentCollaborationOpenInput, _signal: AbortSignal): Promise<DocumentCollaborationRoom> {
		return new BrowserDocumentCollaborationConnection(input.schema, input.clientId, input.document, input.roomId ?? "editor-browser-room", true);
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

if (new URLSearchParams(location.search).get('locale') === 'zh-CN') { setNlsMessages('zh-CN', messages); }
const schema = createDefaultDocumentSchema();
const apiDocument = schema.createDocument([schema.createNode("paragraph", { content: [schema.createText("editor-api")] })]);
const apiModel = TextModel.create(schema, apiDocument);
const codeBlockResource = URI.parse("inmemory://editor/code-block.ash-academic");
const structuredResource = URI.parse("inmemory://editor/document.ash-academic");
const codeBlockDocument = schema.createDocument([schema.createNode("codeBlock", {
	attrs: { language: "typescript" },
	content: [createTextNode("editor-text", "const editor = 1;")],
	id: "editor-code-block",
})], "editor-text-document");
const codeBlockFiles = new MemoryTextFiles(codeBlockResource, serializeDocument(codeBlockDocument, schema));
const structuredFiles = new MemoryTextFiles(structuredResource, serializeDocument(documentFromPlainText(schema, "Title\nBody"), schema));
const disposables = new DisposableStore();
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
const copies = disposables.add(new BrowserWorkingCopyService());
const files = { onDidChangeFiles: codeBlockFiles.onDidChangeFiles, resolve: (request: TextFileResolveRequest, signal: AbortSignal) => (request.resource.toString() === codeBlockResource.toString() ? codeBlockFiles : structuredFiles).resolve(request, signal), save: (request: TextFileSaveRequest, signal: AbortSignal) => (request.resource.toString() === codeBlockResource.toString() ? codeBlockFiles : structuredFiles).save(request, signal) };
services.registerInstance(IDocumentEditorTextModelService, disposables.add(new DocumentEditorTextModelService(files, copies)));
const codeBlockPane = disposables.add(registerTestComponentServices(services).createInstance(DocumentEditorPane, { contentType: 'application/vnd.ash.document+json' }));
const structuredPane = disposables.add(registerTestComponentServices(services).createInstance(DocumentEditorPane, { contentType: 'application/vnd.ash.document+json', createDocumentCollaborationService: () => new BrowserDocumentCollaborationService() }));

codeBlockPane.create(requiredElement("#code-block"));
structuredPane.create(requiredElement("#document-editor"));
codeBlockPane.layout({ width: 900, height: 300 });
structuredPane.layout({ width: 900, height: 300 });
await codeBlockPane.setInput({ resource: codeBlockResource, label: "snippet.ts" }, new AbortController().signal);
await structuredPane.setInput({ resource: structuredResource, label: "paper" }, new AbortController().signal);

window.ashAcademicIntegration = {
	apiDocumentType: apiModel.document.type,
	getBundleIds: () => EditorExtensionsRegistry.getEditorContributions().map(contribution => contribution.id),
	getCodeBlockText: () => codeBlockPane.getDocument().content[0]?.content[0]?.text,
	getStructuredBlockTexts: () => structuredPane.getDocument().content.map(block => block.content.find(child => child.text !== undefined)?.text ?? ""),
	getStructuredFirstTextMarks: () => structuredPane.getDocument().content[0]?.content[0]?.marks ?? [],
	getStructuredSelection: () => structuredPane.getDocumentSelection(),
	getOpenedLinks: () => openedLinks,
	saveCodeBlock: () => codeBlockPane.save(),
	getSavedCodeBlock: () => codeBlockFiles.read(codeBlockResource),
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
