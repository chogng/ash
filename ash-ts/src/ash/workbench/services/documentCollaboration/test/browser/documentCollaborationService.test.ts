import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { isCancellationError } from "../../../../../base/common/errors.js";
import { createDefaultDocumentSchema } from "../../../../../editor/common/model/documentSchema.js";
import type { DocumentCollaborationOpenInput, IDocumentCollaborationService } from '../../common/documentCollaborationService.js';
import { DocumentCollaborationService } from "../../browser/documentCollaborationService.js";

test("Workbench collaboration routes an empty endpoint to its App Server service", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(environment.window, "prompt", { configurable: true, value: () => "" });
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
	using service = new DocumentCollaborationService(environment.window as unknown as Window, appServer);
	const input = createOpenInput();
	await assert.rejects(service.open(input, new AbortController().signal), error => error === expected);
	assert.equal(received, input);
	environment.window.close();
});

test("Workbench collaboration owns remote service configuration", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const prompts = ["https://collaboration.ash.example", "too-short"];
	Object.defineProperty(environment.window, "prompt", { configurable: true, value: () => prompts.shift() ?? null });
	using service = new DocumentCollaborationService(environment.window as unknown as Window, undefined);
	await assert.rejects(service.open(createOpenInput(), new AbortController().signal), /bearer token must contain at least 32/);
	environment.window.close();
});

test("Workbench collaboration reports service selection cancellation", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(environment.window, "prompt", { configurable: true, value: () => null });
	using service = new DocumentCollaborationService(environment.window as unknown as Window, undefined);
	await assert.rejects(service.open(createOpenInput(), new AbortController().signal), isCancellationError);
	environment.window.close();
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
