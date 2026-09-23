import assert from "node:assert/strict";
import { test } from "mocha";
import {
	createDisconnectedRendererApi,
	WebAppServerUnavailableError,
} from "../../../../platform/app-server/browser/rendererApi.js";

test("disconnected Web renderer API reports stopped without events", async () => {
	const api = createDisconnectedRendererApi();
	const states: string[] = [];
	const subscription = api.appServer.onConnectionState((state) => {
		states.push(state);
	});

	assert.equal(await api.appServer.getConnectionState(), "stopped");
	assert.deepEqual(states, []);
	subscription.dispose();
});

test("disconnected Web renderer API rejects product operations explicitly", async () => {
	const api = createDisconnectedRendererApi();

	await assert.rejects(
		api.session.list(),
		(error: unknown) => {
			assert.ok(error instanceof WebAppServerUnavailableError);
			assert.equal(error.operation, "session.list");
			assert.match(error.message, /no Web host API was provided/);
			return true;
		},
	);
	await assert.rejects(
		api.typst.compile({
			source: "Hello",
		}),
		(error: unknown) => {
			assert.ok(error instanceof WebAppServerUnavailableError);
			assert.equal(error.operation, "typst.compile");
			return true;
		},
	);
	await assert.rejects(
		api.contentSearch.start({
			query: "needle",
			patternKind: "literal",
			caseSensitivity: "smart",
			includePatterns: [],
			excludePatterns: [],
			maxResults: 100,
		}),
		(error: unknown) => {
			assert.ok(error instanceof WebAppServerUnavailableError);
			assert.equal(error.operation, "contentSearch.start");
			return true;
		},
	);
	await assert.rejects(
		api.fs.readFile({ path: "src/main.ts" }),
		(error: unknown) => {
			assert.ok(error instanceof WebAppServerUnavailableError);
			assert.equal(error.operation, "fs.readFile");
			return true;
		},
	);
	await assert.rejects(
		api.syntax.analyze({ documentId: "model-1", language: "rust", revision: 1, text: "fn main() {}\n" }),
		(error: unknown) => {
			assert.ok(error instanceof WebAppServerUnavailableError);
			assert.equal(error.operation, "syntax.analyze");
			return true;
		},
	);
	await assert.rejects(
		api.syntax.selectionRanges({ documentId: "model-1", language: "rust", revision: 1, text: "fn main() {}\n", ranges: [] }),
		(error: unknown) => {
			assert.ok(error instanceof WebAppServerUnavailableError);
			assert.equal(error.operation, "syntax.selectionRanges");
			return true;
		},
	);
	await assert.rejects(api.syntax.close({ documentId: "model-1" }), (error: unknown) => {
		assert.ok(error instanceof WebAppServerUnavailableError);
		assert.equal(error.operation, "syntax.close");
		return true;
	});
	await assert.rejects(
		api.turn.resolveInteraction({
			commandId: "resolve-1",
			sessionId: "session-1",
			threadId: "thread-1",
			turnId: "turn-1",
			requestId: "request-1",
			expectedSequence: 1,
			response: {
				type: "approval",
				response: { decision: "decline" },
			},
		}),
		(error: unknown) => {
			assert.ok(error instanceof WebAppServerUnavailableError);
			assert.equal(error.operation, "turn.resolveInteraction");
			return true;
		},
	);
});
