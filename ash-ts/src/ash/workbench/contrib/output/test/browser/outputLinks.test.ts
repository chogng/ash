import assert from "node:assert/strict";
import test from "node:test";
import { URI } from "../../../../../base/common/uri.js";
import { detectOutputLinks } from "../../browser/outputLinks.js";

test("detectOutputLinks resolves relative and absolute workspace locations", () => {
	const folder = { id: "project", uri: URI.file("/workspace/project"), name: "project", index: 0 };
	const links = detectOutputLinks("src/main.ts:12:7 and /workspace/project/test/a.test.ts(3,2)", [folder]);
	assert.deepEqual(links.map(link => [link.resource.fsPath, link.selection.getStartPosition().lineNumber, link.selection.getStartPosition().column]), [
		["/workspace/project/src/main.ts", 12, 7],
		["/workspace/project/test/a.test.ts", 3, 2],
	]);
});

test("detectOutputLinks rejects traversal and paths outside the workspace", () => {
	const folder = { id: "project", uri: URI.file("/workspace/project"), name: "project", index: 0 };
	assert.deepEqual(detectOutputLinks("../secret.ts:1:1 /etc/passwd.txt:2:1", [folder]), []);
});
