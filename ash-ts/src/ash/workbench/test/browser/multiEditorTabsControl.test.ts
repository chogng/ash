import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { DndCssClasses } from "../../../base/browser/ui/dnd/dnd.js";
import { URI } from "../../../base/common/uri.js";
import { InMemoryConfigurationService } from "../../../platform/configuration/common/inMemoryConfigurationService.js";
import type { EditorTabsDelegate } from "../../browser/parts/editor/editorTabsControl.js";
import type { EditorInput } from "../../browser/parts/editor/editorInput.js";
import { MultiEditorTabsControl } from "../../browser/parts/editor/multiEditorTabsControl.js";
import { EditorTitleControl } from "../../browser/parts/editor/editorTitleControl.js";
import { EditorBreadcrumbsEnabledConfiguration, EditorTabsModeConfiguration } from "../../services/editor/common/editorConfiguration.js";
import { WorkbenchConfiguration } from '../../common/configuration.js';

test("MultiEditorTabsControl reports the tab edge used as a drag drop insertion point", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const drops: Array<{ target: EditorInput | undefined; position: "before" | "after" }> = [];
	const previews: EditorInput[] = [];
	let dragging = false;
	const control = new MultiEditorTabsControl(dom.window.document.body, {
		activate: () => undefined,
		preview: (input) => previews.push(input),
		close: () => undefined,
		startDrag: () => {
			dragging = true;
		},
		isDragging: () => dragging,
		drop: (target, position) => drops.push({ target, position }),
		dropExternal: () => undefined,
		endDrag: () => {
			dragging = false;
		},
	} satisfies EditorTabsDelegate);
	const first = input("first");
	const second = input("second");
	control.setEditors([descriptor(first), descriptor(second)], first);
	const tabs = control.domNode.querySelectorAll<HTMLElement>(".ash-tab");
	const firstTab = tabs[0];
	const secondTab = tabs[1];
	assert.ok(firstTab);
	assert.ok(secondTab);
	Object.defineProperty(secondTab, "getBoundingClientRect", {
		value: () => ({ left: 100, width: 100 }),
	});

	firstTab.dispatchEvent(dragEvent(dom.window, "dragstart"));
	secondTab.dispatchEvent(dragEvent(dom.window, "dragenter", 175, 100));
	secondTab.dispatchEvent(dragEvent(dom.window, "dragover", 175, 1700));
	assert.deepEqual(previews, [second]);
	assert.equal(secondTab.classList.contains(DndCssClasses.DropAfter), true);
	secondTab.dispatchEvent(dragEvent(dom.window, "drop", 175));

	assert.deepEqual(drops, [{ target: second, position: "after" }]);
	assert.equal(firstTab.classList.contains(DndCssClasses.Dragging), false);
	control.dispose();
	dom.window.close();
});

test("MultiEditorTabsControl forwards external resource drops to the target tab", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const drops: Array<{ target: EditorInput | undefined; position: "before" | "after" }> = [];
	const control = new MultiEditorTabsControl(dom.window.document.body, {
		activate: () => undefined,
		preview: () => undefined,
		close: () => undefined,
		startDrag: () => undefined,
		isDragging: () => false,
		drop: () => undefined,
		dropExternal: (_event, target, position) => drops.push({ target, position }),
		endDrag: () => undefined,
	});
	const target = input("target");
	control.setEditors([descriptor(target)], target);
	const tab = control.domNode.querySelector<HTMLElement>(".ash-tab");
	assert.ok(tab);
	tab.getBoundingClientRect = () => ({ left: 100, width: 100 } as DOMRect);
	const dataTransfer = externalDataTransfer();

	tab.dispatchEvent(dragEvent(dom.window, "dragover", 125, undefined, dataTransfer));
	assert.equal(dataTransfer.dropEffect, "copy");
	tab.dispatchEvent(dragEvent(dom.window, "drop", 125, undefined, dataTransfer));

	assert.deepEqual(drops, [{ target, position: "before" }]);
	control.dispose();
	dom.window.close();
});

test("EditorTitleControl switches tab modes and breadcrumbs from configuration", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const configuration = new InMemoryConfigurationService();
	const control = new EditorTitleControl(dom.window.document.body, inertDelegate, undefined, configuration);
	const first = input("folder/first");
	const second = input("folder/second");
	control.setEditors([descriptor(first), descriptor(second)], second);

	assert.equal(control.domNode.querySelectorAll(".ash-tab").length, 2);
	const firstTab = control.domNode.querySelector('.ash-tab');
	assert.equal(control.domNode.querySelector('.ash-tab-list')?.classList.contains('ash-tab-list-inset'), true);
	await configuration.updateValue(WorkbenchConfiguration.layoutStyle, 'flat');
	assert.equal(control.domNode.querySelector('.ash-tab-list')?.classList.contains('ash-tab-list-flush'), true);
	assert.equal(control.domNode.querySelector('.ash-tab'), firstTab);
	await configuration.updateValue(WorkbenchConfiguration.layoutStyle, 'modern');
	assert.equal(control.domNode.querySelector('.ash-tab-list')?.classList.contains('ash-tab-list-inset'), true);
	assert.match(control.domNode.querySelector(".ash-editor-breadcrumbs")?.textContent ?? "", /folder.*second/);
	assert.equal(control.height, 57);

	await configuration.updateValue(EditorTabsModeConfiguration, "single");
	assert.equal(control.domNode.querySelectorAll(".ash-tab").length, 1);
	assert.equal(control.domNode.querySelector(".ash-tab-label")?.textContent, "folder/second");

	await configuration.updateValue(EditorTabsModeConfiguration, "none");
	assert.equal(control.domNode.querySelectorAll(".ash-tab").length, 0);
	await configuration.updateValue(EditorBreadcrumbsEnabledConfiguration, false);
	assert.equal((control.domNode.querySelector(".ash-editor-breadcrumbs") as HTMLElement).hidden, true);
	assert.equal(control.height, 35);

	control.dispose();
	configuration.dispose();
	dom.window.close();
});

const inertDelegate: EditorTabsDelegate = {
	activate: () => undefined,
	preview: () => undefined,
	close: () => undefined,
	startDrag: () => undefined,
	isDragging: () => false,
	drop: () => undefined,
	dropExternal: () => undefined,
	endDrag: () => undefined,
};

function input(name: string): EditorInput {
	return { resource: URI.parse(`untitled:/${name}`), label: name };
}

function descriptor(input: EditorInput): { readonly instanceId: string; readonly input: EditorInput; readonly panelId: string; readonly tabId: string } {
	return { instanceId: `${input.label}-instance`, input, panelId: `${input.label}-panel`, tabId: `${input.label}-tab` };
}

function dragEvent(targetWindow: { readonly Event: typeof Event }, type: string, clientX = 0, timeStamp?: number, dataTransfer?: DataTransfer): DragEvent {
	const event = new targetWindow.Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperty(event, "clientX", { value: clientX });
	if (timeStamp !== undefined) Object.defineProperty(event, "timeStamp", { value: timeStamp });
	if (dataTransfer) Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
	return event;
}

function externalDataTransfer(): DataTransfer {
	return {
		types: ["text/uri-list"],
		dropEffect: "none",
		getData: () => "file:///C:/project/dropped.ts",
	} as unknown as DataTransfer;
}
