import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { DragAndDropDataKind } from "../../browser/ui/dnd/dnd.js";
import { ListDragOverPosition, ListDragTargetSector } from "../../browser/ui/list/list.js";
import { ListView } from "../../browser/ui/list/listView.js";
import { List } from "../../browser/ui/list/listWidget.js";
import { h } from "../../browser/dom.js";

test("ListView owns flat rows and sizing without Widget selection policy", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const view = new ListView<string>(dom.window.document.body, {
		getId: (item) => item,
		getHeight: () => 24,
		renderItem: (item) => {
			const label = h(dom.window.document, "span");
			label.textContent = item;
			return label;
		},
	});
	view.items = ["First", "Second"];
	assert.equal(view.row(0)?.style.height, "24px");
	assert.equal(view.element.hasAttribute("aria-activedescendant"), false);
	assert.equal(view.element.querySelector(".focused"), null);
	view.updateElementHeight(1, 30);
	assert.equal(view.getElementTop(1), 24);
	assert.equal(view.getElementHeight(1), 30);
	view.dispose();
	dom.window.close();
});

test("List renders in its owner document and owns active navigation", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const list = new List<string>(dom.window.document.body, {
		ariaLabel: "Choices",
		renderItem: (item) => {
			const label = h(dom.window.document, "span");
			label.textContent = item;
			return label;
		},
	});
	const active: (string | undefined)[] = [];
	list.onDidChangeActive(({ item }) => active.push(item));

	list.items = ["First", "Second", "Third"];
	assert.equal(list.element.ownerDocument, dom.window.document);
	assert.equal(list.element.getAttribute("role"), "listbox");
	assert.equal(list.element.getAttribute("aria-label"), "Choices");
	assert.equal(list.activeItem, "First");
	assert.equal(
		list.element.querySelector(".is-active")?.textContent,
		"First",
	);

	list.focusPrevious();
	assert.equal(list.activeItem, "Third");
	list.focusNext();
	assert.equal(list.activeItem, "First");
	assert.deepEqual(active, ["First", "Third", "First"]);

	list.dispose();
	dom.window.close();
});

test("List maps mouse interaction to activation and acceptance", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const list = new List<string>(dom.window.document.body, {
		renderItem: (item) => {
			const label = h(dom.window.document, "span");
			label.textContent = item;
			return label;
		},
	});
	list.items = ["First", "Second"];
	const accepted: string[] = [];
	list.onDidAccept(({ item }) => accepted.push(item));
	const second = list.element.querySelectorAll<HTMLElement>(
		".ash-list-row",
	)[1];
	assert.ok(second);

	second.dispatchEvent(new dom.window.MouseEvent("mousemove", {
		bubbles: true,
	}));
	assert.equal(list.activeItem, "Second");
	second.dispatchEvent(new dom.window.MouseEvent("click", {
		bubbles: true,
	}));
	assert.deepEqual(accepted, ["Second"]);
	assert.equal(second.getAttribute("aria-selected"), "true");

	list.items = [];
	assert.equal(list.activeItem, undefined);
	assert.equal(list.element.childElementCount, 0);

	list.dispose();
	dom.window.close();
});

test("List DnD exposes target sectors and positional feedback", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const events: string[] = [];
	const list = createDndList(dom, {
		onDragStart: (data) => events.push(`start:${data.kind}:${data.types.join(",")}`),
		onDragOver: (data, target, _index, sector) => {
			events.push(`over:${data.kind}:${target}:${sector}`);
			return { accept: true, effect: "move", position: ListDragOverPosition.Before };
		},
		drop: (data, target, _index, sector) => events.push(`drop:${data.kind}:${target}:${sector}`),
	});
	list.items = ["First", "Second"];
	const first = list.row(0)!;
	const second = list.row(1)!;
	second.getBoundingClientRect = () => ({ top: 40, bottom: 80, left: 0, right: 100, width: 100, height: 40, x: 0, y: 40, toJSON() {} });
	const transfer = testDataTransfer();
	first.dispatchEvent(dragEvent(dom, "dragstart", 10, transfer));
	second.dispatchEvent(dragEvent(dom, "dragover", 79, transfer));
	assert.equal(second.classList.contains("ash-dnd-drop-before"), true);
	second.dispatchEvent(dragEvent(dom, "drop", 79, transfer));
	first.dispatchEvent(dragEvent(dom, "dragend", 10, transfer));
	assert.deepEqual(events, [
		`start:${DragAndDropDataKind.Internal}:text/uri-list`,
		`over:${DragAndDropDataKind.Internal}:Second:${ListDragTargetSector.Bottom}`,
		`drop:${DragAndDropDataKind.Internal}:Second:${ListDragTargetSector.Bottom}`,
	]);
	assert.equal(second.classList.contains("ash-dnd-drop-before"), false);
	list.dispose();
	dom.window.close();
});

test("List DnD distinguishes cross-list and native payloads", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const observed: string[] = [];
	const source = createDndList(dom, { onDragOver: () => false, drop: () => {} });
	const target = createDndList(dom, {
		onDragOver: (data) => {
			observed.push(`over:${data.kind}:${data.elements.join(",")}:${data.types.join(",")}`);
			return true;
		},
		drop: (data) => observed.push(`drop:${data.kind}:${data.elements.join(",")}:${data.files.length}`),
	});
	source.items = ["Source"];
	target.items = ["Target"];
	const transfer = testDataTransfer();
	source.row(0)!.dispatchEvent(dragEvent(dom, "dragstart", 0, transfer));
	target.row(0)!.dispatchEvent(dragEvent(dom, "dragover", 0, transfer));
	target.row(0)!.dispatchEvent(dragEvent(dom, "drop", 0, transfer));
	source.row(0)!.dispatchEvent(dragEvent(dom, "dragend", 0, transfer));
	const file = new dom.window.File(["content"], "notes.txt", { type: "text/plain" });
	const nativeTransfer = testDataTransfer(["Files"], [file]);
	target.row(0)!.dispatchEvent(dragEvent(dom, "dragover", 0, nativeTransfer));
	target.row(0)!.dispatchEvent(dragEvent(dom, "drop", 0, nativeTransfer));
	assert.deepEqual(observed, [
		`over:${DragAndDropDataKind.External}:Source:text/uri-list`,
		`drop:${DragAndDropDataKind.External}:Source:0`,
		`over:${DragAndDropDataKind.Native}::Files`,
		`drop:${DragAndDropDataKind.Native}::1`,
	]);
	source.dispose();
	target.dispose();
	dom.window.close();
});

test("List DnD scrolls an overflowing target near its edge", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const list = createDndList(dom, { onDragOver: () => true, drop: () => {} });
	list.items = ["Target"];
	Object.defineProperty(list.element, "clientHeight", { configurable: true, value: 100 });
	Object.defineProperty(list.element, "scrollHeight", { configurable: true, value: 400 });
	list.element.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} });
	const transfer = testDataTransfer(["Files"]);
	list.row(0)!.dispatchEvent(dragEvent(dom, "dragover", 98, transfer));
	await new Promise((resolve) => dom.window.setTimeout(resolve, 40));
	assert.ok(list.element.scrollTop > 0);
	list.row(0)!.dispatchEvent(dragEvent(dom, "drop", 98, transfer));
	list.dispose();
	dom.window.close();
});

test("List DnD keeps feedback across nested leave events and clears an actual leave", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	let leaves = 0;
	const list = createDndList(dom, { onDragOver: () => true, onDragLeave: () => leaves += 1, drop: () => {} });
	list.items = ["Target"];
	const row = list.row(0)!;
	const transfer = testDataTransfer(["Files"]);
	row.dispatchEvent(dragEvent(dom, "dragover", 0, transfer));
	row.dispatchEvent(dragEvent(dom, "dragleave", 0, transfer));
	row.dispatchEvent(dragEvent(dom, "dragover", 0, transfer));
	await new Promise((resolve) => dom.window.setTimeout(resolve, 120));
	assert.equal(row.classList.contains("drag-over"), true);
	assert.equal(leaves, 0);
	row.dispatchEvent(dragEvent(dom, "dragleave", 0, transfer));
	await new Promise((resolve) => dom.window.setTimeout(resolve, 120));
	assert.equal(row.classList.contains("drag-over"), false);
	assert.equal(leaves, 1);
	list.dispose();
	dom.window.close();
});

function createDndList(dom: JSDOM, callbacks: Pick<NonNullable<ConstructorParameters<typeof List<string>>[1]["dnd"]>, "onDragOver" | "drop"> & Partial<NonNullable<ConstructorParameters<typeof List<string>>[1]["dnd"]>>): List<string> {
	return new List<string>(dom.window.document.body, {
		dnd: { getDragURI: (item) => `ash://${item}`, ...callbacks },
		renderItem: (item) => {
			const label = h(dom.window.document, "span");
			label.textContent = item;
			return label;
		},
	});
}

function dragEvent(dom: JSDOM, type: string, clientY: number, dataTransfer: DataTransfer): DragEvent {
	const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientY }) as unknown as DragEvent;
	Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
	return event;
}

function testDataTransfer(initialTypes: readonly string[] = [], files: readonly File[] = []): DataTransfer {
	const types = [...initialTypes];
	const values = new Map<string, string>();
	return {
		dropEffect: "none",
		effectAllowed: "none",
		files,
		types,
		setData(type: string, value: string) {
			values.set(type, value);
			if (!types.includes(type)) types.push(type);
		},
		getData: (type: string) => values.get(type) ?? "",
	} as unknown as DataTransfer;
}
