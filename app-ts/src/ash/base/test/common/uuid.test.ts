import { strict as assert } from "node:assert";
import { test } from "mocha";
import { createUuid, generateUuid, isUuid, parseUuid } from "../../common/uuid.js";

test("createUuid returns canonical random UUIDs", () => {
	const first = createUuid();
	const second = createUuid();

	assert.equal(isUuid(first), true);
	assert.equal(isUuid(second), true);
	assert.notEqual(first, second);
});

test("parseUuid validates and canonicalizes external UUIDs", () => {
	assert.equal(
		parseUuid("9B2C2FD4-9C5A-4E2F-AF10-16C2B97712DD"),
		"9b2c2fd4-9c5a-4e2f-af10-16c2b97712dd",
	);
	assert.throws(() => parseUuid("not-a-uuid"), TypeError);
	assert.throws(() => parseUuid(null), TypeError);
});

test('generateUuid exposes a canonical generated identity', () => {
	assert.equal(isUuid(generateUuid()), true);
});
