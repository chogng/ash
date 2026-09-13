import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "mocha";
import { migrateLegacyLocalProfile } from "../../node/localProfile.js";

test("legacy Desktop resources migrate without overwriting canonical files", async () => {
	const root = await mkdtemp(join(tmpdir(), "ash-local-profile-"));
	try {
		const legacy = join(root, "legacy");
		const profile = join(root, "profile");
		await mkdir(join(legacy, "themes"), { recursive: true });
		await writeFile(join(legacy, "configuration.json"), "legacy", "utf8");
		await writeFile(join(legacy, "keybindings.json"), "bindings", "utf8");
		await writeFile(join(legacy, "keyboard-layout.json"), "layout", "utf8");
		await writeFile(join(legacy, "themes", "custom.json"), "theme", "utf8");

		await migrateLegacyLocalProfile({ legacyUserDataRoot: legacy, profileRoot: profile });
		assert.equal(await readFile(join(profile, "configuration.json"), "utf8"), "legacy");
		assert.equal(await readFile(join(profile, "keybindings.json"), "utf8"), "bindings");
		assert.equal(await readFile(join(profile, "keyboard-layout.json"), "utf8"), "layout");
		assert.equal(await readFile(join(profile, "themes", "custom.json"), "utf8"), "theme");

		await writeFile(join(profile, "configuration.json"), "canonical", "utf8");
		await migrateLegacyLocalProfile({ legacyUserDataRoot: legacy, profileRoot: profile });
		assert.equal(await readFile(join(profile, "configuration.json"), "utf8"), "canonical");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
