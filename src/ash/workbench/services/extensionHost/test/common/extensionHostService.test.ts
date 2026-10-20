import assert from "node:assert/strict";
import { test } from "mocha";
import { EmptyExtensionHostSnapshot } from "../../common/extensionHostService.js";

test("empty Extension Host snapshot is immutable and has no transport surface", () => {
	assert.equal(EmptyExtensionHostSnapshot.fleetGeneration, 0);
	assert.deepEqual(EmptyExtensionHostSnapshot.extensions, []);
	assert.equal(Object.isFrozen(EmptyExtensionHostSnapshot), true);
	assert.equal(Object.isFrozen(EmptyExtensionHostSnapshot.extensions), true);
	assert.equal("rpc" in EmptyExtensionHostSnapshot, false);
});
