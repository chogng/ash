import { URI } from "../../../src/ash/base/common/uri.js";
import { Emitter, type Event } from "../../../src/ash/base/common/event.js";
import { Disposable } from "../../../src/ash/base/common/lifecycle.js";
import { createDefaultDocumentSchema } from "../../../src/ash/editor/editor.api.js";
import { createTextNode } from "../../../src/ash/editor/editor.api.js";
import { TextModel } from "../../../src/ash/editor/editor.api.js";
import "../../../src/ash/editor/editor.academic.all.js";
import { DocumentEditorPane } from "../../../src/ash/workbench/contrib/documentEditor/browser/documentEditorPane.js";
import type { DocumentNode } from "../../../src/ash/editor/common/model/document.js";
import { serializeDocument } from "../../../src/ash/editor/common/model/documentSerialization.js";
import type { DocumentSchema } from "../../../src/ash/editor/common/model/documentSchema.js";
import type { DocumentCollaborationConnection } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationInvite } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationMember } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationOpenInput } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationPresence } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationRoomRole } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
import type { DocumentSelection } from "../../../src/ash/editor/common/core/documentSelection.js";
import type { DocumentCollaborationSnapshot } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationRemoteEnvelope } from "../../../src/ash/editor/contrib/collaboration/common/protocol.js";
import type { DocumentCollaborationEnvelope } from "../../../src/ash/editor/contrib/collaboration/common/protocol.js";
import type { DocumentCollaborationSubmitOutcome } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
import type { IDocumentCollaborationService } from "../../../src/ash/editor/common/services/documentCollaborationService.js";
import { MemoryTextFiles } from "./memoryTextFiles.js";

interface AcademicIntegrationHarness {
	readonly apiDocumentType: string;
	getCodeBlockText(): string | undefined;
	getStructuredBlockTexts(): readonly string[];
	getStructuredFirstTextMarks(): readonly { readonly type: string; readonly attrs: Readonly<Record<string, string | number | boolean | null>> }[];
	getStructuredSelection(): unknown;
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
	async open(input: DocumentCollaborationOpenInput, _signal: AbortSignal): Promise<DocumentCollaborationConnection> {
		return new BrowserDocumentCollaborationConnection(input.schema, input.clientId, input.document, input.roomId ?? "editor-browser-room", true);
	}
}

class BrowserDocumentCollaborationConnection extends Disposable implements DocumentCollaborationConnection {
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

	async updatePresence(_selection: DocumentSelection | undefined, _signal: AbortSignal): Promise<void> {}

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
const structuredFiles = new MemoryTextFiles(structuredResource, "Title\nBody");
const codeBlockPane = new DocumentEditorPane(codeBlockFiles);
const structuredPane = new DocumentEditorPane(structuredFiles, { createDocumentCollaborationService: () => new BrowserDocumentCollaborationService() });

codeBlockPane.create(requiredElement("#code-block"));
structuredPane.create(requiredElement("#document-editor"));
codeBlockPane.layout({ width: 900, height: 300 });
structuredPane.layout({ width: 900, height: 300 });
await codeBlockPane.setInput({ resource: codeBlockResource, label: "snippet.ts" }, new AbortController().signal);
await structuredPane.setInput({ resource: structuredResource, label: "paper" }, new AbortController().signal);

window.ashAcademicIntegration = {
	apiDocumentType: apiModel.document.type,
	getCodeBlockText: () => codeBlockPane.getDocument().content[0]?.content[0]?.text,
	getStructuredBlockTexts: () => structuredPane.getDocument().content.map(block => block.content.find(child => child.text !== undefined)?.text ?? ""),
	getStructuredFirstTextMarks: () => structuredPane.getDocument().content[0]?.content[0]?.marks ?? [],
	getStructuredSelection: () => structuredPane.getDocumentSelection(),
	saveCodeBlock: () => codeBlockPane.save(),
	getSavedCodeBlock: () => codeBlockFiles.read(codeBlockResource),
	dispose: () => {
		apiModel.dispose();
		codeBlockPane.dispose();
		structuredPane.dispose();
		codeBlockFiles.dispose();
		structuredFiles.dispose();
	},
};

function requiredElement(selector: string): HTMLElement {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) throw new Error(`Missing editor integration root '${selector}'`);
	return element;
}
