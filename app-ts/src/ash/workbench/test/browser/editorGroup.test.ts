import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../base/common/uri.js";
import type { EditorInput } from "../../browser/parts/editor/editorInput.js";
import type { IEditorPane } from "../../browser/parts/editor/editorPane.js";
import type { IEditorPart } from "../../browser/parts/editor/editorPart.js";

test("EditorGroup reorders tabs and moves them between groups", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
	try {
		const { EditorGroup } = await import("../../browser/parts/editor/editorGroup.js");
		const { EditorPaneMatch } = await import("../../browser/parts/editor/editorPane.js");
		const { EditorPaneRegistry } = await import("../../browser/parts/editor/editorRegistry.js");
		const registry = new EditorPaneRegistry();
		registry.register({
			id: "test.editor",
			name: "Test Editor",
			canOpen: () => EditorPaneMatch.Default,
			create: () => new TestEditorPane(),
		});
		const source = new EditorGroup(dom.window.document.body, { registry });
		const target = new EditorGroup(dom.window.document.body, { registry });
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
		source.dispose();
		target.dispose();
	} finally {
		if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
		else Reflect.deleteProperty(globalThis, "window");
		dom.window.close();
	}
});

test("EditorGroup selects a range of tabs and resolves close-command targets", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
	try {
		const { EditorGroup } = await import("../../browser/parts/editor/editorGroup.js");
		const { EditorPaneMatch } = await import("../../browser/parts/editor/editorPane.js");
		const { EditorPaneRegistry } = await import("../../browser/parts/editor/editorRegistry.js");
		const { resolveCommandsContext } = await import("../../browser/parts/editor/editorCommandsContext.js");
		const registry = new EditorPaneRegistry();
		registry.register({ id: "test.editor", name: "Test Editor", canOpen: () => EditorPaneMatch.Default, create: () => new TestEditorPane() });
		const group = new EditorGroup(dom.window.document.body, { registry });
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
			const context = resolveCommandsContext([{ groupId: group.id, editorIndex: 0 }], { groups: [group] } as unknown as IEditorPart);
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

class TestEditorPane implements IEditorPane {
	readonly id = "test.editor";

	create(_parent: HTMLElement): void {}
	async setInput(_input: EditorInput, _signal: AbortSignal): Promise<void> {}
	clearInput(): void {}
	layout(_dimension: { readonly width: number; readonly height: number }): void {}
	setVisible(_visibility: number): void {}
	focus(): void {}
	dispose(): void {}
	[Symbol.dispose](): void {
		this.dispose();
	}
}

function input(name: string): EditorInput {
	return { resource: URI.parse(`untitled:/${name}`), label: name };
}
