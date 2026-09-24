import assert from "node:assert/strict";
import {
	mkdtemp,
	readFile,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "mocha";
import { URI } from "../../../../base/common/uri.js";
import {
	ConfigurationRegistry,
	Extensions as ConfigurationExtensions,
	type IConfigurationRegistry,
} from "../../../../platform/configuration/common/configurationRegistry.js";
import { InMemoryConfigurationService } from "../../../../platform/configuration/common/inMemoryConfigurationService.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import {
	type IConfigurationApi,
	type IConfigurationSnapshot,
	type IConfigurationUpdateRequest,
	configurationValues,
	validateConfigurationDocument,
	validateConfigurationSnapshot,
	validateConfigurationUpdateRequest,
} from "../../../../platform/configuration/common/configurationIpc.js";
import {
	ConfigurationMainService,
} from "../../../../platform/configuration/electron-main/configurationMainService.js";
import {
	WorkbenchConfigurationService,
} from "../../../../workbench/services/configuration/browser/configurationService.js";
import {
	ConfigurationResourceRevisionConflictError,
} from "../../../../platform/configuration/common/configurationResourceService.js";
import { ConfigurationTarget, addToValueTree, getConfigValueInTarget, getConfigurationValue, getLanguageTagSettingPlainKey, isConfigurationOverrides, isConfigurationUpdateOverrides, isConfigured, merge, removeFromValueTree, toValuesTree } from "../../../../platform/configuration/common/configuration.js";

test("configuration registry is owned by the standard platform Registry entry", async () => {
	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	assert.equal(Registry.knows(ConfigurationExtensions.Configuration), true);
	const enabled = registry.registerConfiguration({
		key: "test.configuration.registry.enabled",
		defaultValue: false,
		parse(value): boolean {
			if (typeof value !== "boolean") throw new TypeError("enabled must be a boolean");
			return value;
		},
	});
	using service = new InMemoryConfigurationService();
	const changes: string[] = [];
	using listener = service.onDidChangeConfiguration(event => changes.push(...event.change.keys));

	assert.equal(service.getValue(enabled), false);
	await service.updateValue(enabled, true);
	assert.equal(service.getValue(enabled), true);
	assert.deepEqual(changes, [enabled]);
});

test("configuration contracts expose target inspection and validate overrides", () => {
	const values = { defaultValue: 12, userValue: 14, workspaceValue: 16 };
	assert.equal(getConfigValueInTarget(values, ConfigurationTarget.DEFAULT), 12);
	assert.equal(getConfigValueInTarget(values, ConfigurationTarget.USER), 14);
	assert.equal(getConfigValueInTarget(values, ConfigurationTarget.WORKSPACE), 16);
	assert.equal(getConfigValueInTarget(values, ConfigurationTarget.MEMORY), undefined);
	assert.equal(isConfigurationOverrides({ overrideIdentifier: "typescript" }), true);
	assert.equal(isConfigurationOverrides({ resource: URI.parse("file:///workspace/file.ts") }), true);
	assert.equal(isConfigurationOverrides({ overrideIdentifier: 1 }), false);
	assert.equal(isConfigurationOverrides({ resource: {} }), false);
	assert.equal(isConfigurationUpdateOverrides({ overrideIdentifiers: ["typescript"] }), true);
	assert.equal(isConfigurationUpdateOverrides({ overrideIdentifier: "typescript" }), false);
	assert.equal(isConfigured(values), true);
	assert.equal(isConfigured({ defaultValue: 12 }), false);
});

test("configuration value-tree helpers preserve canonical section semantics", () => {
	const conflicts: string[] = [];
	const values = toValuesTree({ "editor.fontSize": 14, "editor.wordWrap": "on" }, message => conflicts.push(message));
	assert.equal(Object.getPrototypeOf(values), null);
	assert.equal(Object.getPrototypeOf(values.editor), null);
	assert.deepEqual(JSON.parse(JSON.stringify(values)), { editor: { fontSize: 14, wordWrap: "on" } });
	assert.equal(getConfigurationValue<number>(values, "editor.fontSize"), 14);
	assert.equal(getConfigurationValue(values, "editor.missing", 20), 20);
	addToValueTree(values, "editor.minimap.enabled", true, message => conflicts.push(message));
	removeFromValueTree(values, "editor.wordWrap");
	merge(values, { editor: { fontSize: 16, lineNumbers: "on" } }, false);
	assert.deepEqual(JSON.parse(JSON.stringify(values)), { editor: { fontSize: 14, minimap: { enabled: true }, lineNumbers: "on" } });
	assert.deepEqual(conflicts, []);
	assert.equal(getLanguageTagSettingPlainKey("[javascript][typescript]"), "javascript, typescript");
});

test("configuration validators bound the complete wire document", () => {
	assert.deepEqual(
		validateConfigurationSnapshot({
			revision: 2,
			document: {
				version: 1,
				source: '{ "editor.fontSize": 14 }\n',
			},
		}),
		{
			revision: 2,
			document: {
				version: 1,
				source: '{ "editor.fontSize": 14 }\n',
			},
		},
	);
	assert.throws(
		() => validateConfigurationDocument({
			version: 1,
			source: '{ "__proto__.unsafe": true }',
		}),
		/invalid configuration key/,
	);
	assert.throws(
		() => validateConfigurationDocument({ version: 1, values: { 'editor.fontSize': 14 } }),
		/configuration object must contain exactly: source, version/,
	);
	assert.throws(
		() => validateConfigurationUpdateRequest({
			expectedRevision: -1,
			document: { version: 1, source: '{}' },
		}),
		/non-negative safe integer/,
	);
});

test("workbench configuration resolves typed defaults and live snapshots", async () => {
	const registry = new ConfigurationRegistry();
	const fontSize = registry.registerConfiguration({
		key: "editor.fontSize",
		defaultValue: 12,
		parse(value): number {
			if (!Number.isInteger(value) || (value as number) < 8) {
				throw new TypeError("font size must be an integer of at least 8");
			}
			return value as number;
		},
	});
	const api = new TestConfigurationApi({
		revision: 0,
			document: {
				version: 1,
				source: '{ "editor.fontSize": 16 }\n',
		},
	});
	using service = new WorkbenchConfigurationService({
		api,
		registry,
	});
	let changes = 0;
	using listener = service.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration(fontSize)) changes += 1;
	});

	assert.equal(service.getValue<number>(fontSize), 12);
	await service.reloadConfiguration();
	assert.equal(service.getValue<number>(fontSize), 16);

	await service.updateValue(fontSize, 18);
	assert.equal(service.getValue<number>(fontSize), 18);

	api.emit({
		revision: 2,
		document: {
			version: 1,
			source: '{ "editor.fontSize": 20 }\n',
		},
	});
	assert.equal(service.getValue<number>(fontSize), 20);
	await service.updateValue(fontSize, undefined);
	assert.equal(service.getValue<number>(fontSize), 12);
	assert.equal(changes, 4);
	await assert.rejects(
		() => service.updateValue(fontSize, 4),
		/font size/,
	);
});

test("workbench configuration preserves editable JSONC source", async () => {
	const registry = new ConfigurationRegistry();
	const fontSize = registry.registerConfiguration({
		key: "editor.fontSize",
		defaultValue: 12,
		parse(value): number {
			if (!Number.isInteger(value) || (value as number) < 8) throw new TypeError("font size must be at least 8");
			return value as number;
		},
	});
	using service = new WorkbenchConfigurationService({ registry });
	const observed: string[] = [];
	using listener = service.onDidChangeResource(snapshot => observed.push(snapshot.source));

	assert.deepEqual(await service.read(), { source: "{}\n", revision: 0 });
	const source = `{
		// Keep this user explanation.
		"editor.fontSize": 16,
		"extension.unregistered": true,
	}\n`;
	assert.deepEqual(await service.write(source, 0), {
		source,
		revision: 1,
	});
	assert.equal(service.getValue<number>(fontSize), 16);
	assert.deepEqual(observed, [source]);
	await service.updateValue(fontSize, 18);
	assert.match((await service.read()).source, /Keep this user explanation/u);
	assert.match((await service.read()).source, /"editor\.fontSize": 18/u);
	await assert.rejects(() => service.write('{ "editor.fontSize": 4 }', 2), /font size/);
	await assert.rejects(() => service.write('{}', 0), ConfigurationResourceRevisionConflictError);
	await assert.rejects(() => service.write('[]', 2), /must be an object/);
});

test("workbench configuration applies and reports language overrides", async () => {
	const registry = new ConfigurationRegistry();
	const tabSize = registry.registerConfiguration({
		key: "editor.tabSize",
		defaultValue: 4,
		parse(value): number {
			if (!Number.isInteger(value)) throw new TypeError("tab size must be an integer");
			return value as number;
		},
	});
	const api = new TestConfigurationApi({
		revision: 0,
		document: {
			version: 1,
			source: '{ "editor.tabSize": 2, "[typescript]": { "editor.tabSize": 8 } }\n',
		},
	});
	using service = new WorkbenchConfigurationService({ api, registry });
	const changes: Array<{ readonly keys: string[]; readonly overrides: [string, string[]][]; readonly typescript: boolean; readonly javascript: boolean }> = [];
	using listener = service.onDidChangeConfiguration(event => changes.push({
		keys: event.change.keys,
		overrides: event.change.overrides,
		typescript: event.affectsConfiguration(tabSize, { overrideIdentifier: "typescript" }),
		javascript: event.affectsConfiguration(tabSize, { overrideIdentifier: "javascript" }),
	}));

	await service.reloadConfiguration();
	assert.equal(service.getValue<number>(tabSize), 2);
	assert.equal(service.getValue<number>(tabSize, { overrideIdentifier: "typescript" }), 8);
	assert.equal(service.getValue<number>(tabSize, { overrideIdentifier: "javascript" }), 2);

	api.emit({
		revision: 1,
		document: {
			version: 1,
			source: '{ "editor.tabSize": 2, "[typescript]": { "editor.tabSize": 6 } }\n',
		},
	});
	assert.deepEqual(changes.at(-1), {
		keys: [],
		overrides: [["typescript", [tabSize]]],
		typescript: true,
		javascript: false,
	});
	await service.updateValue(tabSize, 10, { overrideIdentifier: "typescript" });
	assert.equal(service.getValue<number>(tabSize, { overrideIdentifier: "typescript" }), 10);
	assert.match((await service.read()).source, /"\[typescript\]"\s*:\s*\{\s*"editor\.tabSize"\s*:\s*10/u);
});

test("workbench configuration preserves combined override blocks in data and inspection", async () => {
	const registry = new ConfigurationRegistry();
	const tabSize = registry.registerConfiguration({
		key: "editor.tabSize",
		defaultValue: 4,
		parse(value): number {
			if (!Number.isInteger(value)) throw new TypeError("tab size must be an integer");
			return value as number;
		},
	});
	const api = new TestConfigurationApi({
		revision: 0,
		document: {
			version: 1,
			source: '{ "editor.tabSize": 2, "[typescript][javascript]": { "editor.tabSize": 8 } }\n',
		},
	});
	using service = new WorkbenchConfigurationService({ api, registry });
	await service.reloadConfiguration();

	assert.deepEqual(service.getConfigurationData().userLocal, {
		contents: {
			editor: { tabSize: 2 },
			"[typescript][javascript]": { "editor.tabSize": 8 },
		},
		keys: [tabSize, "[typescript][javascript]"],
		overrides: [{ identifiers: ["typescript", "javascript"], keys: [tabSize], contents: { editor: { tabSize: 8 } } }],
	});
	assert.deepEqual(service.keys().user, [tabSize, "[typescript][javascript]"]);
	assert.deepEqual(service.inspect<number>(tabSize, { overrideIdentifier: "typescript" }), {
		defaultValue: 4,
		userValue: 8,
		userLocalValue: 8,
		value: 8,
		default: { value: 4 },
		user: {
			value: 2,
			override: 8,
			overrides: [{ identifiers: ["typescript", "javascript"], value: 8 }],
		},
		userLocal: {
			value: 2,
			override: 8,
			overrides: [{ identifiers: ["typescript", "javascript"], value: 8 }],
		},
		overrideIdentifiers: ["typescript", "javascript"],
	});

	await service.updateValue(tabSize, 6, { overrideIdentifiers: ["javascript", "typescript", "javascript"] }, ConfigurationTarget.USER_LOCAL);
	assert.equal(service.getValue<number>(tabSize, { overrideIdentifier: "javascript" }), 6);
	assert.match((await service.read()).source, /"\[typescript\]\[javascript\]"\s*:\s*\{\s*"editor\.tabSize"\s*:\s*6/u);
	assert.doesNotMatch((await service.read()).source, /"\[javascript\]"\s*:/u);
	assert.doesNotMatch((await service.read()).source, /"\[typescript\]"\s*:/u);
});

test("workbench configuration rejects unsupported write owners and resource overrides", async () => {
	const registry = new ConfigurationRegistry();
	const tabSize = registry.registerConfiguration({
		key: "editor.tabSize",
		defaultValue: 4,
		parse(value): number {
			if (!Number.isInteger(value)) throw new TypeError("tab size must be an integer");
			return value as number;
		},
	});
	using service = new WorkbenchConfigurationService({ registry });

	await service.updateValue(tabSize, 6, ConfigurationTarget.USER);
	assert.equal(service.getValue<number>(tabSize), 6);
	await assert.rejects(service.updateValue(tabSize, 8, ConfigurationTarget.WORKSPACE), /Unable to write editor\.tabSize to target 5/u);
	await assert.rejects(service.updateValue(tabSize, 8, 99 as ConfigurationTarget), /target is invalid/u);
	await assert.rejects(
		service.updateValue(tabSize, 8, { resource: URI.parse("file:///workspace/file.ts") }, ConfigurationTarget.USER_LOCAL),
		/does not support resource overrides/u,
	);
	assert.throws(
		() => service.getValue(tabSize, { resource: URI.parse("file:///workspace/file.ts") }),
		/does not support resource overrides/u,
	);
});

test("workbench configuration change compares values after language overrides", async () => {
	const registry = new ConfigurationRegistry();
	const tabSize = registry.registerConfiguration({
		key: "editor.tabSize",
		defaultValue: 4,
		parse(value): number {
			if (!Number.isInteger(value)) throw new TypeError("tab size must be an integer");
			return value as number;
		},
	});
	const api = new TestConfigurationApi({
		revision: 0,
		document: {
			version: 1,
			source: '{ "editor.tabSize": 2, "[typescript]": { "editor.tabSize": 8 } }\n',
		},
	});
	using service = new WorkbenchConfigurationService({ api, registry });
	await service.reloadConfiguration();
	let affectsTypeScript: boolean | undefined;
	let affectsJavaScript: boolean | undefined;
	using listener = service.onDidChangeConfiguration(event => {
		affectsTypeScript = event.affectsConfiguration(tabSize, { overrideIdentifier: "typescript" });
		affectsJavaScript = event.affectsConfiguration(tabSize, { overrideIdentifier: "javascript" });
	});

	api.emit({
		revision: 1,
		document: {
			version: 1,
			source: '{ "editor.tabSize": 6, "[typescript]": { "editor.tabSize": 8 } }\n',
		},
	});

	assert.equal(affectsTypeScript, false);
	assert.equal(affectsJavaScript, true);
});

test("main configuration service persists atomic revisions", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ash-configuration-"));
	try {
		const filePath = join(directory, "configuration.json");
		const service = await ConfigurationMainService.create({ filePath });

		const updated = await service.update({
			expectedRevision: 0,
			document: {
				version: 1,
				source: '{\n\t// persisted\n\t"editor.fontSize": 14,\n}\n',
			},
		});
		assert.equal(updated.revision, 1);
		await assert.rejects(
			() => service.update({
					expectedRevision: 0,
					document: { version: 1, source: '{}' },
			}),
			/revision conflict/,
		);
		await service.close();

		assert.deepEqual(
			JSON.parse(await readFile(filePath, "utf8")),
			updated.document,
		);
		assert.deepEqual(configurationValues(updated.document), { "editor.fontSize": 14 });
		const reopened = await ConfigurationMainService.create({ filePath });
		assert.deepEqual(reopened.read(), {
			revision: 0,
			document: updated.document,
		});
		await reopened.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

class TestConfigurationApi implements IConfigurationApi {
	private readonly listeners = new Set<(snapshot: unknown) => void>();
	private snapshot: IConfigurationSnapshot;

	constructor(snapshot: IConfigurationSnapshot) {
		this.snapshot = snapshot;
	}

	read(): Promise<unknown> {
		return Promise.resolve(this.snapshot);
	}

	update(
		request: IConfigurationUpdateRequest,
	): Promise<unknown> {
		if (request.expectedRevision !== this.snapshot.revision) {
			return Promise.reject(new Error("revision conflict"));
		}
		this.snapshot = {
			revision: this.snapshot.revision + 1,
			document: request.document,
		};
		return Promise.resolve(this.snapshot);
	}

	onDidChange(
		listener: (snapshot: unknown) => void,
	): { dispose(): void } {
		this.listeners.add(listener);
		return {
			dispose: () => this.listeners.delete(listener),
		};
	}

	emit(snapshot: IConfigurationSnapshot): void {
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener(snapshot);
	}
}
