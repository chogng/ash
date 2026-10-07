import assert from "node:assert/strict";
import { test } from "mocha";
import { codeSessionsProfile } from "../../../code/common/codeSessionsProfile.js";
import { createSessionsProfile } from "../../common/sessionsProfile.js";

test("dedicated Sessions profile belongs to the Code product", () => {
	assert.equal(codeSessionsProfile.id, "code-sessions");
	assert.equal(codeSessionsProfile.workbenchRelativePath, "../workbench/workbench.html");
});

test("Sessions profiles reject a non-sibling Workbench return path", () => {
	assert.throws(
		() => createSessionsProfile({
			id: "invalid",
			label: "Invalid",
			titlebarActionId: "ash.invalid",
			workbenchRelativePath: "../../outside.html",
		}),
		/sibling Workbench page/,
	);
});
