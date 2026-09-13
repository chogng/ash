import { strict as assert } from "node:assert";
import { test } from "mocha";
import {
	operatingSystemFromNodePlatform,
	operatingSystemFromUserAgent,
} from "../../common/environment.js";

test("operatingSystemFromNodePlatform normalizes supported hosts", () => {
	assert.equal(operatingSystemFromNodePlatform("win32"), "windows");
	assert.equal(operatingSystemFromNodePlatform("darwin"), "mac");
	assert.equal(operatingSystemFromNodePlatform("linux"), "linux");
	assert.equal(operatingSystemFromNodePlatform("freebsd"), "unknown");
});

test("operatingSystemFromUserAgent recognizes browser hosts", () => {
	assert.equal(
		operatingSystemFromUserAgent(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
		),
		"windows",
	);
	assert.equal(
		operatingSystemFromUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
		),
		"mac",
	);
	assert.equal(
		operatingSystemFromUserAgent("Mozilla/5.0 (X11; Linux x86_64)"),
		"linux",
	);
	assert.equal(operatingSystemFromUserAgent("Unknown Browser"), "unknown");
});
