import assert from "node:assert/strict";
import { test } from "mocha";
import { CancellationError } from "../../../../base/common/errors.js";
import { invokeExtensionHost, normalizeExtensionHostPayload, normalizeExtensionHostSnapshot, type ExtensionHostInvocationRequest, type JsonValue } from "../../common/extensionHostApi.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

test("normalizes one exact isolated Extension Host fleet snapshot", () => {
	const snapshot = normalizeExtensionHostSnapshot({
		generation: 7,
		extensions: [{
			id: "acme.demo",
			version: "1.0.0",
			packageDigest: DIGEST,
			runtimeApiVersion: 1,
			activationGeneration: 3,
			incarnation: 2,
			lifecycle: "ready",
			failure: null,
			stderr: "extension diagnostic\n",
			outputEvents: [
				{ sequence: 4, incarnation: 2, activationGeneration: 3, operation: "create", channelId: "review", label: "Review", kind: "log" },
				{ sequence: 5, incarnation: 2, activationGeneration: 3, operation: "append", channelId: "review", text: "ready\n", severity: "information", category: "lifecycle" },
			],
			registrations: [
				{ registrationId: "commands", kind: "command", command: "acme.run", title: "Run" },
				{ registrationId: "language", kind: "languageProvider", languageIds: ["typescript"], operations: ["completion", "hover"] },
				{ registrationId: "tests", kind: "testProfileProvider", providerId: "acme.tests", label: "Acme Tests" },
			],
		}],
	});

	assert.equal(snapshot.generation, 7);
	assert.equal(snapshot.extensions[0]?.activationGeneration, 3);
	assert.equal(snapshot.extensions[0]?.registrations[2]?.kind, "testProfileProvider");
	assert.equal(snapshot.extensions[0]?.stderr, "extension diagnostic\n");
	assert.equal(snapshot.extensions[0]?.outputEvents[1]?.operation.operation, "append");
	assert.equal(Object.isFrozen(snapshot.extensions[0]?.registrations), true);
});

test("rejects malformed fleet authority and oversized JSON payloads", () => {
	assert.throws(() => normalizeExtensionHostSnapshot({ generation: 1, extensions: [{ id: "bad", version: "1", packageDigest: DIGEST, runtimeApiVersion: 1, activationGeneration: 0, incarnation: 1, lifecycle: "ready", failure: null, stderr: "", outputEvents: [], registrations: [] }] }), /activation generation/);
	assert.throws(() => normalizeExtensionHostSnapshot({ generation: 1, extensions: [{ id: "bad", version: "1", packageDigest: DIGEST, runtimeApiVersion: 1, activationGeneration: 1, incarnation: null, lifecycle: "ready", failure: null, stderr: "", outputEvents: [], registrations: [] }] }), /must have an incarnation/);
	const maximum = normalizeExtensionHostPayload("x".repeat(512 * 1024 - 2));
	assert.equal(typeof maximum === "string" ? maximum.length : -1, 512 * 1024 - 2);
	assert.throws(() => normalizeExtensionHostPayload("x".repeat(512 * 1024 - 1)), /too large/);
});

test("polls a fenced invocation until one strict terminal result", async () => {
	const requests: ExtensionHostInvocationRequest[] = [];
	let reads = 0;
	let cancels = 0;
	const result = await invokeExtensionHost({
		start: async request => { requests.push(request); return { invocationId: "invoke-1" }; },
		read: async invocationId => { assert.equal(invocationId, "invoke-1"); return ++reads === 1 ? { state: "pending" } : { state: "succeeded", payload: { ok: true } }; },
		cancel: async () => { cancels += 1; return { disposition: "alreadyTerminal" }; },
	}, invocation(), new AbortController().signal, { now: () => 100, wait: async () => undefined });

	assert.equal(typeof result === "object" && result !== null && !Array.isArray(result) ? (result as { readonly ok?: JsonValue }).ok : undefined, true);
	assert.equal(requests[0]?.activationGeneration, 4);
	assert.equal(requests[0]?.incarnation, 5);
	assert.equal(reads, 2);
	assert.equal(cancels, 0);
});

test("cancels a pending connection-owned invocation when the caller aborts", async () => {
	const controller = new AbortController();
	const cancelled: string[] = [];
	await assert.rejects(invokeExtensionHost({
		start: async () => ({ invocationId: "invoke-2" }),
		read: async () => ({ state: "pending" }),
		cancel: async invocationId => { cancelled.push(invocationId); return { disposition: "requested" }; },
	}, invocation(), controller.signal, {
		now: () => 100,
		wait: async () => { controller.abort("test"); throw new CancellationError("cancelled", "test"); },
	}), CancellationError);
	assert.deepEqual(cancelled, ["invoke-2"]);
});

function invocation(): ExtensionHostInvocationRequest {
	return {
		extensionId: "acme.demo",
		registrationId: "command",
		activationGeneration: 4,
		incarnation: 5,
		operation: "execute",
		payload: Object.freeze({ arguments: Object.freeze([]) }),
		deadlineUnixMillis: 1_000,
	};
}
