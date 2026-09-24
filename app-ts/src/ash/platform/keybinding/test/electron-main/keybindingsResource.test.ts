import assert from "node:assert/strict";
import {
	mkdtemp,
	readFile,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "mocha";
import {
	type IKeybindingsResourceApi,
	type IKeybindingsResourceSnapshot,
	type IKeybindingsResourceUpdateRequest,
	validateKeybindingsResource,
	validateKeybindingsResourceSnapshot,
} from "../../../../platform/keybinding/common/keybindingsResource.js";
import {
	KeybindingsResourceMainService,
} from "../../../../platform/keybinding/electron-main/keybindingsResourceMainService.js";
import {
	WorkbenchKeybindingsResourceService,
} from "../../../../workbench/services/keybinding/browser/keybindingsResourceService.js";

test("keybinding resource wire data validates complete ordered rules", () => {
	assert.deepEqual(
		validateKeybindingsResourceSnapshot({
			revision: 3,
			bindings: [{
				key: "primary+k primary+c",
				command: "ash.comment",
				when: "editorFocus && mode == edit",
				args: { source: "keyboard" },
				mac: "cmd+k cmd+c",
				linux: null,
			}],
		}),
		{
			revision: 3,
			bindings: [{
				key: "primary+k primary+c",
				command: "ash.comment",
				when: "editorFocus && mode == edit",
				args: { source: "keyboard" },
				mac: "cmd+k cmd+c",
				linux: null,
			}],
		},
	);
	assert.throws(
		() => validateKeybindingsResource([{
			key: "ctrl+k",
			command: "ash.test",
			unknown: true,
		}]),
		/unknown field/,
	);
	assert.throws(
		() => validateKeybindingsResource([{
			key: "ctrl+k",
			command: "ash.test",
			when: "editorFocus &&",
		}]),
		/Expected/,
	);
});

test("workbench keybindings resource accepts host snapshots and CAS updates", async () => {
	const api = new TestKeybindingsResourceApi({
		revision: 0,
		bindings: [{
			key: "primary+n",
			command: "ash.new",
		}],
	});
	using service = new WorkbenchKeybindingsResourceService({ api });
	const observed: string[][] = [];
	using listener = service.onDidChangeKeybindings((bindings) => {
		observed.push(bindings.map(({ key }) => key));
	});

	assert.deepEqual(service.getKeybindings(), []);
	await service.reload();
	assert.equal(service.getKeybindings()[0].command, "ash.new");

	await service.updateKeybindings([{
		key: "primary+shift+n",
		command: "ash.newWindow",
	}]);
	assert.equal(
		service.getKeybindings()[0].command,
		"ash.newWindow",
	);

	api.emit({
		revision: 2,
		bindings: [{
			key: "primary+w",
			command: null,
		}],
	});
	assert.equal(service.getKeybindings()[0].command, null);
	assert.deepEqual(observed, [
		["primary+n"],
		["primary+shift+n"],
		["primary+w"],
	]);
});

test("main keybindings resource persists a standalone top-level array", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ash-keybindings-"));
	try {
		const filePath = join(directory, "keybindings.json");
		const service = await KeybindingsResourceMainService.create({ filePath });
		const bindings = [{
			key: "primary+n",
			command: "ash.new",
			when: "windowFocused",
		}] as const;

		const updated = await service.update({
			expectedRevision: 0,
			bindings,
		});
		assert.equal(updated.revision, 1);
		await assert.rejects(
			() => service.update({
				expectedRevision: 0,
				bindings: [],
			}),
			/revision conflict/,
		);
		await service.close();

		assert.deepEqual(
			JSON.parse(await readFile(filePath, "utf8")),
			bindings,
		);
		const reopened = await KeybindingsResourceMainService.create({ filePath });
		assert.deepEqual(reopened.read(), {
			revision: 0,
			bindings,
		});
		await reopened.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

class TestKeybindingsResourceApi implements IKeybindingsResourceApi {
	private readonly listeners = new Set<(snapshot: unknown) => void>();
	private snapshot: IKeybindingsResourceSnapshot;

	constructor(snapshot: IKeybindingsResourceSnapshot) {
		this.snapshot = snapshot;
	}

	read(): Promise<unknown> {
		return Promise.resolve(this.snapshot);
	}

	update(request: IKeybindingsResourceUpdateRequest): Promise<unknown> {
		if (request.expectedRevision !== this.snapshot.revision) {
			return Promise.reject(new Error("revision conflict"));
		}
		this.snapshot = {
			revision: this.snapshot.revision + 1,
			bindings: request.bindings,
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

	emit(snapshot: IKeybindingsResourceSnapshot): void {
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener(snapshot);
	}
}
