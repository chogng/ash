import assert from "node:assert/strict";
import { test } from "mocha";
import { isCancellationError } from "../../../../../base/common/errors.js";
import { createDefaultDocumentSchema } from "../../../../../editor/common/model/documentSchema.js";
import { DialogResult, IDialogService } from "../../../../../platform/dialogs/common/dialogs.js";
import { ServiceContainer } from "../../../../../platform/instantiation/common/instantiation.js";
import type { DocumentCollaborationOpenInput, IDocumentCollaborationService } from '../../common/documentCollaborationService.js';
import { DialogService } from "../../../../services/dialogs/common/dialogService.js";
import { DocumentCollaborationService } from "../../browser/documentCollaborationService.js";

test("Workbench collaboration routes an empty endpoint to its App Server service", async () => {
	using dialogs = new DialogService();
	using subscription = dialogs.model.onWillShowDialog(item => item.close({ button: DialogResult.Primary, values: [''] }));
	using services = new ServiceContainer();
	services.registerInstance(IDialogService, dialogs);
	const expected = new Error("opened by App Server service");
	let received: DocumentCollaborationOpenInput | undefined;
	const appServer: IDocumentCollaborationService = {
		dispose: () => undefined,
		[Symbol.dispose]: () => undefined,
		open: input => {
			received = input;
			return Promise.reject(expected);
		},
	};
	using service = services.createInstance(DocumentCollaborationService, appServer);
	const input = createOpenInput();
	await assert.rejects(service.open(input, new AbortController().signal), error => error === expected);
	assert.equal(received, input);
});

test("Workbench collaboration owns remote service configuration", async () => {
	using dialogs = new DialogService();
	const prompts = ["https://collaboration.ash.example", "too-short"];
	using subscription = dialogs.model.onWillShowDialog(item => item.close({ button: DialogResult.Primary, values: [prompts.shift()!] }));
	using services = new ServiceContainer();
	services.registerInstance(IDialogService, dialogs);
	using service = services.createInstance(DocumentCollaborationService, undefined);
	await assert.rejects(service.open(createOpenInput(), new AbortController().signal), /bearer token must contain at least 32/);
});

test("Workbench collaboration reports service selection cancellation", async () => {
	using dialogs = new DialogService();
	using subscription = dialogs.model.onWillShowDialog(item => item.close({ button: DialogResult.Cancel }));
	using services = new ServiceContainer();
	services.registerInstance(IDialogService, dialogs);
	using service = services.createInstance(DocumentCollaborationService, undefined);
	await assert.rejects(service.open(createOpenInput(), new AbortController().signal), isCancellationError);
});

function createOpenInput(): DocumentCollaborationOpenInput {
	const schema = createDefaultDocumentSchema();
	return {
		clientId: "client-a",
		schemaId: "stanza-document-v1",
		schema,
		document: schema.createDocument([schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("Hello", { id: "text-1" })] })], "document-1"),
	};
}
