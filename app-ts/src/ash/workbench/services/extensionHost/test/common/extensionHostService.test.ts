import assert from "node:assert/strict";
import { test } from "mocha";
import { EmptyExtensionHostSnapshot, type ExtensionHostExtension, type ExtensionHostSnapshot } from "../../common/extensionHostService.js";

test("empty Extension Host snapshot is immutable and has no transport surface", () => {
	assert.equal(EmptyExtensionHostSnapshot.fleetGeneration, 0);
	assert.deepEqual(EmptyExtensionHostSnapshot.extensions, []);
	assert.equal(Object.isFrozen(EmptyExtensionHostSnapshot), true);
	assert.equal(Object.isFrozen(EmptyExtensionHostSnapshot.extensions), true);
	assert.equal("rpc" in EmptyExtensionHostSnapshot, false);
});

test("Extension Host registrations belong to one isolated extension process", () => {
	const extension: ExtensionHostExtension = Object.freeze({
		id: "ash.demo",
		version: "1.0.0",
		packageDigest: "sha256:demo",
		runtimeApiVersion: 1,
		activationGeneration: 2,
		incarnation: 3,
		state: "ready",
		failure: undefined,
		stderr: "",
		registrations: Object.freeze([{ id: "demo.command", kind: "command" as const }]),
	});
	const snapshot: ExtensionHostSnapshot = Object.freeze({ fleetGeneration: 4, extensions: Object.freeze([extension]) });

	assert.equal(snapshot.fleetGeneration, 4);
	assert.equal(snapshot.extensions[0]?.incarnation, 3);
	assert.equal(snapshot.extensions[0]?.activationGeneration, 2);
	assert.ok((snapshot.extensions[0]?.activationGeneration ?? 0) >= 1);
	assert.equal(snapshot.extensions[0]?.state, "ready");
	assert.deepEqual(snapshot.extensions[0]?.registrations, [{ id: "demo.command", kind: "command" }]);
	assert.equal("contributions" in snapshot, false);
});

test("Extension Host domain keeps stopped runtimes and authority failure codes", () => {
	const extension: ExtensionHostExtension = Object.freeze({
		id: "ash.stopped",
		version: "1.0.0",
		packageDigest: "sha256:stopped",
		runtimeApiVersion: undefined,
		activationGeneration: 1,
		incarnation: undefined,
		state: "stopped",
		failure: Object.freeze({ code: "runtime.not_started", incarnation: undefined, message: "Not started" }),
		stderr: "",
		registrations: Object.freeze([]),
	});

	assert.equal(extension.state, "stopped");
	assert.equal(extension.activationGeneration, 1);
	assert.equal(extension.failure?.code, "runtime.not_started");
});
