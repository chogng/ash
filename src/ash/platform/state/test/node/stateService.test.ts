import assert from "node:assert/strict";
import {
	mkdtemp,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "mocha";
import { StateService } from "../../../../platform/state/node/stateService.js";

test("state service persists and reloads values", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ash-state-"));
	try {
		const statePath = join(directory, "state.json");

		const stateService = await StateService.create(statePath);
		stateService.setItem("windowState", { version: 1, width: 1200 });
		await stateService.close();

		const reopenedStateService = await StateService.create(statePath);
		assert.deepEqual(reopenedStateService.getItem("windowState"), {
			version: 1,
			width: 1200,
		});
		await reopenedStateService.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("state service treats malformed JSON as empty state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ash-state-"));
	try {
		const statePath = join(directory, "state.json");
		await writeFile(statePath, "{not-json", "utf8");

		const stateService = await StateService.create(statePath);
		assert.equal(stateService.getItem("windowState"), undefined);
		stateService.setItem("windowState", { version: 1 });
		await stateService.close();

		const reopenedStateService = await StateService.create(statePath);
		assert.deepEqual(reopenedStateService.getItem("windowState"), { version: 1 });
		await reopenedStateService.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
