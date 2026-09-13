import assert from "node:assert/strict";
import { test } from "mocha";
import { codeSessionsProfile } from "../../browser/code/codeSessionsProfile.js";
import { resolveSessionsPageUrl } from "../../browser/common/sessionNavigation.js";
import { createSessionsProfile } from "../../common/sessionsProfile.js";

test("dedicated Sessions profile belongs to the Code Workbench mode", () => {
	assert.equal(codeSessionsProfile.modeId, "code");
	assert.equal(codeSessionsProfile.workbenchRelativePath, "../workbench/workbench.html");
});

test("Sessions navigation only resolves a sibling renderer page", () => {
	assert.equal(
		resolveSessionsPageUrl("../workbench/workbench.html", "file:///ash/electron-browser/sessions/sessions-code.html"),
		"file:///ash/electron-browser/workbench/workbench.html",
	);
	assert.throws(
		() => resolveSessionsPageUrl("https://example.com", "file:///ash/electron-browser/sessions/sessions-code.html"),
		/sibling renderer directory/,
	);
});

test("Sessions profiles reject a non-sibling Workbench return path", () => {
	assert.throws(
		() => createSessionsProfile({
			id: "invalid",
			modeId: "code",
			label: "Invalid",
			titlebarActionId: "ash.invalid",
			workbenchRelativePath: "../../outside.html",
		}),
		/sibling Workbench page/,
	);
});
