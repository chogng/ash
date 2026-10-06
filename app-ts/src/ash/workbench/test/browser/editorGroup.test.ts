import type { IResourceEditorInput } from '../../common/editor.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import { createBinaryDiffEditorInput } from '../../common/editor/diffEditorInput.js';
import { DiffEditorAssociationsConfiguration, EditorAssociationsConfiguration } from '../../browser/parts/editor/editorConfiguration.js';
import { createTestEditorServices } from '../common/testEditorServices.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../base/common/uri.js";
import type { IEditorPane } from "../../browser/parts/editor/editorPane.js";
import type { IEditorGroupsService } from "../../services/editor/common/editorGroupsService.js";

test('EditorGroupView keeps the caller language when resource detection has no language', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
	try {
		const { EditorGroupView } = await import('../../browser/parts/editor/editorGroupView.js');
		const { EditorPaneMatch } = await import('../../browser/parts/editor/editorPane.js');
		const { EditorPaneRegistry } = await import('../../browser/editor.js');
		const registry = new EditorPaneRegistry();
		registry.registerEditorPane({
			id: 'test.editor',
			name: 'Explicit text language',
			canOpen: input => input.languageId === 'jsonc' ? EditorPaneMatch.Default : EditorPaneMatch.None,
			create: () => new TestEditorPane(),
		});
		using services = createTestEditorServices(undefined, undefined, dom.window.document);
		using group = services.createInstance(EditorGroupView, dom.window.document.body, {
			registry,
			languageResolver: { resolveLanguageId: () => undefined },
		});
		const input = { resource: URI.parse('test-settings:/settings.json'), languageId: 'jsonc' };
		await group.openEditor(input, { pinned: true, ignoreError: true });
		assert.deepEqual(group.inputs, [input]);
	} finally {
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else delete (globalThis as { window?: Window; }).window;
		dom.window.close();
	}
});

test("EditorGroupView reorders tabs and moves them between groups", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
	try {
		const { EditorGroupView } = await import("../../browser/parts/editor/editorGroupView.js");
		const { EditorPaneMatch } = await import("../../browser/parts/editor/editorPane.js");
		const { EditorPaneRegistry } = await import("../../browser/editor.js");
		const registry = new EditorPaneRegistry();
		registry.registerEditorPane({
			id: "test.editor",
			name: "Test Editor",
			canOpen: () => EditorPaneMatch.Default,
			create: () => new TestEditorPane(),
		});
		using services = createTestEditorServices(undefined, undefined, dom.window.document);
		const source = services.createInstance(EditorGroupView, dom.window.document.body, { registry });
		const target = services.createInstance(EditorGroupView, dom.window.document.body, { registry });
		const first = input("first");
		const second = input("second");
		await source.openEditor(first);
		await source.openEditor(second);
		const secondInstanceId = source.editors.find(editor => editor.input === second)?.instanceId;

		source.moveEditor(first, source.getEditorInsertionIndex(second, "after"));
		assert.deepEqual(source.inputs, [second, first]);

		await source.moveEditorTo(second, target, 0);
		assert.deepEqual(source.inputs, [first]);
		assert.deepEqual(target.inputs, [second]);
		assert.equal(target.activeInput, second);
		assert.equal(target.editors[0]?.instanceId, secondInstanceId);
		await source.openEditor(second);
		source.stickEditor(second);
		target.stickEditor(second);
		const targetInstanceId = target.editors[0]!.instanceId;
		const changes: string[] = [];
		using listener = target.onDidChangeEditors(event => changes.push(event.kind));
		target.stickEditor(second);
		assert.deepEqual(changes, []);
		await source.moveEditorTo(second, target, 0);
		assert.deepEqual({ source: source.inputs, target: target.inputs, sticky: target.isSticky(second), identity: target.editors[0]!.instanceId }, { source: [first], target: [second], sticky: true, identity: targetInstanceId });
		await target.openEditor(first);
		target.stickEditor(first);
		await target.replaceEditor(second, first);
		assert.deepEqual({ inputs: target.inputs, sticky: target.isSticky(first) }, { inputs: [first], sticky: true });

		source.dispose();
		target.dispose();
	} finally {
		if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
		else Reflect.deleteProperty(globalThis, "window");
		dom.window.close();
	}
});

test("EditorGroupView selects a range of tabs and resolves close-command targets", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
	try {
		const { EditorGroupView } = await import("../../browser/parts/editor/editorGroupView.js");
		const { EditorPaneMatch } = await import("../../browser/parts/editor/editorPane.js");
		const { EditorPaneRegistry } = await import("../../browser/editor.js");
		const { resolveCommandsContext } = await import("../../browser/parts/editor/editorCommandsContext.js");
		const registry = new EditorPaneRegistry();
		registry.registerEditorPane({ id: "test.editor", name: "Test Editor", canOpen: () => EditorPaneMatch.Default, create: () => new TestEditorPane() });
		using services = createTestEditorServices(undefined, undefined, dom.window.document);
		const group = services.createInstance(EditorGroupView, dom.window.document.body, { registry });
		try {
			const first = input("first");
			const second = input("second");
			const third = input("third");
			for (const editor of [first, second, third]) await group.openEditor(editor);
			const tab = (name: string) => {
				const element = group.domNode.querySelector<HTMLButtonElement>(`.ash-tab-label[aria-label="${name}"]`);
				assert.ok(element);
				return element;
			};
			tab("first").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
			assert.deepEqual(group.selectedInputs, [first, third]);
			assert.equal(group.activeInput, third);
			tab("second").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, shiftKey: true }));
			assert.deepEqual(group.selectedInputs, [first, second]);
			assert.equal(tab("first").getAttribute("aria-selected"), "true");
			assert.equal(tab("second").getAttribute("aria-selected"), "true");
			assert.equal(tab("third").getAttribute("aria-selected"), "false");
			const context = resolveCommandsContext([{ groupId: group.id, editorIndex: 0 }], { groups: [group], getGroup: (id: string) => id === group.id ? group : undefined } as unknown as IEditorGroupsService);
			assert.deepEqual(context.groupedEditors[0]?.editors, [first, second]);
			for (const editor of context.groupedEditors[0]!.editors) await group.closeEditor(editor);
			assert.deepEqual(group.inputs, [third]);
			assert.deepEqual(group.selectedInputs, [third]);
			const fourth = input("fourth");
			await group.openEditor(fourth);
			tab("third").focus();
			tab("third").dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: " ", ctrlKey: true }));
			assert.deepEqual(group.selectedInputs, [third, fourth]);
			assert.equal(dom.window.document.activeElement, tab("third"));
			tab("third").click();
			assert.deepEqual(group.selectedInputs, [third]);
			assert.equal(group.activeInput, third);
		} finally {
			group.dispose();
		}
	} finally {
		if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
		else Reflect.deleteProperty(globalThis, "window");
		dom.window.close();
	}
});

test('binary comparisons select the diff association using the modified file path', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
	try {
		const { EditorGroupView } = await import('../../browser/parts/editor/editorGroupView.js');
		const { EditorPaneMatch } = await import('../../browser/parts/editor/editorPane.js');
		const { EditorPaneRegistry } = await import('../../browser/editor.js');
		using configuration = new InMemoryConfigurationService();
		await configuration.updateValue(EditorAssociationsConfiguration, { '*.bin': 'regular.editor' });
		await configuration.updateValue(DiffEditorAssociationsConfiguration, { '*.bin': 'comparison.editor' });
		const registry = new EditorPaneRegistry();
		using regular = registry.registerEditorPane({ id: 'regular.editor', name: 'Regular', canOpen: () => EditorPaneMatch.Default, create: () => new TestEditorPane('regular.editor') });
		using comparison = registry.registerEditorPane({ id: 'comparison.editor', name: 'Comparison', canOpen: () => EditorPaneMatch.Default, create: () => new TestEditorPane('comparison.editor') });
		using services = createTestEditorServices(configuration, undefined, dom.window.document);
		using group = services.createInstance(EditorGroupView, dom.window.document.body, { registry, configurationService: configuration });
		const input = createBinaryDiffEditorInput({ resource: URI.file('/project/before.dat') }, { resource: URI.file('/project/after.bin') });
		await group.openEditor(input, { pinned: true, ignoreError: true });
		assert.deepEqual(group.editors.map(editor => ({ paneId: editor.paneId, input: editor.input })), [{ paneId: 'comparison.editor', input }]);
	} finally {
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else Reflect.deleteProperty(globalThis, 'window');
		dom.window.close();
	}
});

class TestEditorPane implements IEditorPane {
	constructor(readonly id: string = "test.editor") { }

	create(_parent: HTMLElement): void { }
	async setInput(_input: IResourceEditorInput, _signal: AbortSignal): Promise<void> { }
	clearInput(): void { }
	layout(_dimension: { readonly width: number; readonly height: number; }): void { }
	setVisible(_visibility: number): void { }
	focus(): void { }
	dispose(): void { }
	[Symbol.dispose](): void {
		this.dispose();
	}
}

function input(name: string): IResourceEditorInput {
	return { resource: URI.parse(`untitled:/${name}`), label: name };
}
