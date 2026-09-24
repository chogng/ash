import assert from "node:assert/strict";
import { test } from "mocha";
import { normalizeExternalUrl } from "../../common/openerService.js";

test("normalizeExternalUrl accepts absolute HTTP(S) URLs", () => {
	assert.equal(normalizeExternalUrl("https://example.test/oauth?state=1"), "https://example.test/oauth?state=1");
	assert.equal(normalizeExternalUrl("http://127.0.0.1:3000/callback"), "http://127.0.0.1:3000/callback");
});

test("normalizeExternalUrl rejects local and executable schemes", () => {
	assert.throws(() => normalizeExternalUrl("/relative"), /absolute/u);
	assert.throws(() => normalizeExternalUrl("file:///tmp/secret"), /not allowed/u);
	assert.throws(() => normalizeExternalUrl("javascript:alert(1)"), /not allowed/u);
});
