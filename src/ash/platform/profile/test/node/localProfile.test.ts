import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
		await writeFile(join(legacy, "configuration.json"), JSON.stringify({ version: 1, source: '{\n\t// existing choice\n\t"editor.fontSize": 14\n}\n' }), "utf8");
		await writeFile(join(legacy, "keybindings.json"), "bindings", "utf8");
		await writeFile(join(legacy, "keyboard-layout.json"), "layout", "utf8");
		await writeFile(join(legacy, "themes", "custom.json"), "theme", "utf8");

		await migrateLegacyLocalProfile({ legacyUserDataRoot: legacy, profileRoot: profile });
		assert.equal(await readFile(join(profile, "settings.json"), "utf8"), '{\n\t// existing choice\n\t"editor.fontSize": 14\n}\n');
		await assert.rejects(access(join(profile, "configuration.json")), { code: "ENOENT" });
		assert.equal(await readFile(join(profile, "keybindings.json"), "utf8"), "bindings");
		assert.equal(await readFile(join(profile, "keyboard-layout.json"), "utf8"), "layout");
		assert.equal(await readFile(join(profile, "themes", "custom.json"), "utf8"), "theme");

		await writeFile(join(profile, "settings.json"), '{ "editor.fontSize": 16 }', "utf8");
		await migrateLegacyLocalProfile({ legacyUserDataRoot: legacy, profileRoot: profile });
		assert.equal(await readFile(join(profile, "settings.json"), "utf8"), '{ "editor.fontSize": 16 }');
		await assert.rejects(access(join(profile, "configuration.json")), { code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("conflicting profile settings and legacy configuration stay available for resolution", async () => {
	const root = await mkdtemp(join(tmpdir(), "ash-local-profile-conflict-"));
	try {
		const profile = join(root, "profile");
		await mkdir(profile);
		const legacySource = JSON.stringify({ version: 1, source: '{ "editor.fontSize": 14 }' });
		await writeFile(join(profile, "configuration.json"), legacySource);
		await writeFile(join(profile, "settings.json"), '{ "editor.fontSize": 16 }');
		assert.deepEqual(await migrateLegacyLocalProfile({ legacyUserDataRoot: join(root, "legacy"), profileRoot: profile }), {
			legacyPath: join(profile, "configuration.json"),
			settingsPath: join(profile, "settings.json"),
		});
		assert.equal(await readFile(join(profile, "configuration.json"), "utf8"), legacySource);
		assert.equal(await readFile(join(profile, "settings.json"), "utf8"), '{ "editor.fontSize": 16 }');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
