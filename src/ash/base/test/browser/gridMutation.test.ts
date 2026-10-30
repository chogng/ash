import { Orientation } from '../../browser/ui/sash/sash.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IPositionedRectangle } from '../../browser/geometry.js';
import { h } from '../../browser/dom.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	PointerEvent: browserEnvironment.window.MouseEvent,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { Direction, Grid, SerializableGrid, Sizing } = await import(
	'../../browser/ui/grid/grid.js'
);

class TestView {
	readonly element: HTMLDivElement;
	bounds: IPositionedRectangle | undefined;

	constructor(
		ownerDocument: Document,
		readonly minimumWidth = 0,
		readonly maximumWidth = Number.POSITIVE_INFINITY,
		readonly minimumHeight = 0,
		readonly maximumHeight = Number.POSITIVE_INFINITY,
	) {
		this.element = h(ownerDocument, 'div');
	}

	layout(bounds: IPositionedRectangle): void { this.bounds = bounds; }
}

class SerializableTestView extends TestView {
	onVisibilityChange: (() => void) | undefined;
	constructor(
		ownerDocument: Document,
		readonly id: string,
	) {
		super(ownerDocument);
	}

	toJSON(): string {
		return this.id;
	}

	setVisible(): void {
		this.onVisibilityChange?.();
	}
}

test('Grid numeric insertion and cross-branch movement preserve leading sizes and the focused input', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const [main, files, editor, terminal] = Array.from({ length: 4 }, () => new TestView(dom.window.document));
		using grid = new Grid(dom.window.document.body, { type: 'leaf', view: main!, size: 900 });
		grid.layout(900, 600);
		grid.addView(files!, 300, main!, Direction.Right);
		grid.addView(editor!, 180, files!, Direction.Down);
		grid.addView(terminal!, 100, main!, Direction.Left);
		assert.deepEqual([main, files, editor, terminal].map(view => Math.round(grid.getViewSize(view!).width)), [600, 200, 200, 100]);
		// Card frame insets and animations do not participate in layout navigation.
		for (const view of [main, files, editor, terminal]) view!.element.getBoundingClientRect = () => { throw new Error('Navigation must use committed Grid boxes'); };
		assert.deepEqual(grid.getNeighborViews(main!, Direction.Right), [files, editor]);
		const input = dom.window.document.createElement('textarea');
		input.value = 'retained input';
		editor!.element.append(input);
		input.focus();
		input.setSelectionRange(2, 6);
		grid.moveView(editor!, 150, main!, Direction.Left);
		assert.equal(dom.window.document.activeElement, input);
		assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 6]);
		assert.deepEqual([main, files, editor, terminal].map(view => Math.round(grid.getViewSize(view!).width)), [600, 50, 150, 100]);
		grid.resizeView(editor!, { width: 200 });
		assert.deepEqual(grid.getViewSize(editor!), { width: 200, height: 600 });
		assert.deepEqual(grid.getViewSize(), { width: 900, height: 600 });
	} finally { dom.window.close(); }
});

test('SerializableGrid migrates legacy string enums before constructing live views', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const oldLayout: unknown = {
			type: 'branch', orientation: 'horizontal', size: 800, priority: 'normal', children: [
				{ type: 'leaf', data: 'files', size: 200, visible: true, priority: 'low' },
				{ type: 'leaf', data: 'editor', size: 600, visible: false, priority: 'high' },
			],
		};
		const views: SerializableTestView[] = [];
		const deserializer = {
			fromJSON: (data: unknown) => {
				const view = new SerializableTestView(dom.window.document, String(data));
				views.push(view);
				return view;
			}
		};
		using grid = SerializableGrid.deserialize(dom.window.document.body, oldLayout, deserializer);
		grid.layout(800, 600);
		assert.equal(grid.orientation, Orientation.HORIZONTAL);
		assert.equal(grid.isViewVisible(views[1]!), false);
		const saved = grid.serialize();
		assert.equal(saved.priority, 0);
		assert.equal(saved.type === 'branch' && saved.children[1]!.size, 600);
		assert.throws(() => SerializableGrid.deserialize(dom.window.document.body, { ...oldLayout as object, orientation: 'diagonal' }, deserializer), /serialized branch/);
		assert.equal(views.length, 2, 'invalid geometry is rejected before any view is created');
	} finally { dom.window.close(); }
});

test('Grid addresses topology mutations by view identity', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const left = new TestView(dom.window.document, 100);
	const editor = new TestView(dom.window.document, 100);
	const panel = new TestView(dom.window.document, 100);
	const auxiliary = new TestView(dom.window.document, 100);
	const grid = new Grid(dom.window.document.body, {
		type: 'branch',
		orientation: Orientation.HORIZONTAL,
		size: 800,
		children: [
			{ type: 'leaf', view: left, size: 200 },
			{ type: 'leaf', view: editor, size: 600 },
		],
	});
	grid.layout(800, 600);

	grid.addView(panel, Sizing.Split, editor, Direction.Down);
	assert.deepEqual(grid.getViewSize(editor), { width: 600, height: 300 });
	assert.deepEqual(grid.getViewSize(panel), { width: 600, height: 300 });

	grid.addView(auxiliary, 100, editor, Direction.Right);
	assert.deepEqual(grid.getViewSize(auxiliary), { width: 100, height: 300 });

	grid.removeView(panel);
	assert.equal(panel.element.parentElement, null);
	assert.deepEqual(grid.getViewSize(editor), { width: 500, height: 600 });

	grid.moveView(auxiliary, 100, left, Direction.Left);
	assert.deepEqual(grid.getViewSize(auxiliary), { width: 100, height: 600 });
	assert.equal(auxiliary.element.parentElement?.style.left, '0px');
	assert.equal(left.element.parentElement?.style.left, '100px');

	grid.dispose();
	dom.window.close();
});

test('SerializableGrid persists a mutated GridView topology', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const editor = new SerializableTestView(dom.window.document, 'editor');
	const panel = new SerializableTestView(dom.window.document, 'panel');
	const grid = new SerializableGrid(dom.window.document.body, {
		type: 'leaf',
		view: editor,
		size: 600,
	});
	grid.layout(800, 600);
	grid.addView(panel, Sizing.Split, editor, Direction.Down);

	const snapshot = grid.serialize();
	const restoredViews = new Map<string, SerializableTestView>();
	const restored = SerializableGrid.deserialize(
		dom.window.document.body,
		snapshot,
		{
			fromJSON(data) {
				if (typeof data !== 'string') {
					throw new TypeError('Serialized test view ID must be a string');
				}
				const view = new SerializableTestView(dom.window.document, data);
				restoredViews.set(data, view);
				return view;
			},
		},
	);
	restored.layout(800, 600);

	assert.deepEqual(
		restored.getViewSize(restoredViews.get('editor')!),
		{ width: 800, height: 300 },
	);
	assert.deepEqual(
		restored.getViewSize(restoredViews.get('panel')!),
		{ width: 800, height: 300 },
	);

	restored.dispose();
	grid.dispose();
	dom.window.close();
});

test('Grid maximization restores nested geometry, hidden caches and the focused view', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const [navigation, chat, files, terminal, info, outside] = ['navigation', 'chat', 'files', 'terminal', 'info', 'outside']
		.map(id => new SerializableTestView(dom.window.document, id));
	const input = dom.window.document.createElement('input');
	input.value = 'retained document';
	files!.element.append(input);
	const grid = new SerializableGrid(dom.window.document.body, {
		type: 'branch', orientation: Orientation.HORIZONTAL, size: 900, children: [
			{ type: 'leaf', view: navigation!, size: 100 },
			{
				type: 'branch', orientation: Orientation.VERTICAL, size: 700, children: [
					{ type: 'leaf', view: chat!, size: 350 },
					{
						type: 'branch', orientation: Orientation.HORIZONTAL, size: 250, children: [
							{ type: 'leaf', view: files!, size: 450 },
							{ type: 'leaf', view: terminal!, size: 250 },
						],
					},
				],
			},
			{ type: 'leaf', view: info!, size: 180, visible: false },
			{ type: 'leaf', view: outside!, size: 100 },
		],
	});
	try {
		grid.layout(900, 600);
		const normal = grid.serialize();
		const views = [navigation!, chat!, files!, terminal!, info!, outside!];
		for (const view of views) {
			view.onVisibilityChange = () => {
				for (const candidate of views) {
					assert.doesNotThrow(() => grid.isViewVisible(candidate), 'visibility observers see a complete tree');
				}
			};
		}
		const filesParent = files!.element.parentElement;
		input.focus();
		input.setSelectionRange(2, 7);
		files!.element.scrollTop = 55;
		const transitions: boolean[] = [];
		grid.onDidChangeViewMaximized(value => {
			assert.equal(grid.hasMaximizedView(), value);
			transitions.push(value);
		});

		grid.maximizeView(files!, [navigation!, info!]);
		assert.equal(grid.isViewMaximized(files!), true);
		assert.equal(grid.isViewVisible(chat!), false);
		assert.equal(grid.isViewVisible(terminal!), false);
		assert.equal(grid.isViewVisible(info!), false, 'excluded hidden views stay hidden');
		assert.equal(grid.isViewVisible(navigation!), true);
		assert.deepEqual(grid.getViewSize(files!), { width: 800, height: 600 });
		assert.equal(files!.element.parentElement, filesParent, 'maximizing retains the live content attachment');
		assert.equal(dom.window.document.activeElement, input);
		grid.exitMaximizedView();
		assert.deepEqual(grid.serialize(), normal);
		assert.equal(dom.window.document.activeElement, input);
		assert.deepEqual([input.selectionStart, input.selectionEnd, files!.element.scrollTop], [2, 7, 55]);

		grid.maximizeView(terminal!, [navigation!]);
		grid.maximizeView(files!, [navigation!]);
		assert.equal(grid.isViewMaximized(files!), true);
		grid.exitMaximizedView();
		assert.deepEqual(grid.serialize(), normal, 'switching the maximized view retains the original arrangement');
		assert.deepEqual(transitions, [true, false, true, false, true, false]);

		grid.maximizeView(files!, [navigation!]);
		grid.setViewVisible(info!, true);
		assert.equal(grid.hasMaximizedView(), false);
		assert.equal(grid.isViewVisible(info!), true);
		assert.equal(grid.isViewVisible(chat!), true);
		assert.equal(grid.isViewVisible(terminal!), true);
		grid.setViewVisible(info!, false);
		grid.maximizeView(files!, [navigation!]);
		grid.resizeView(terminal!, { width: 340, height: 250 });
		assert.equal(grid.hasMaximizedView(), false);
		assert.equal(grid.getViewSize(terminal!).width, 340);
		for (const view of views) view.onVisibilityChange = undefined;
		grid.maximizeView(files!, [navigation!]);
		grid.moveView(terminal!, Sizing.Split, chat!, Direction.Right);
		assert.equal(grid.hasMaximizedView(), false);
		assert.equal(grid.isViewVisible(chat!), true);
		assert.equal(grid.isViewVisible(terminal!), true);
		grid.maximizeView(files!);
		grid.removeView(files!);
		assert.equal(grid.hasMaximizedView(), false);
		assert.equal(files!.element.isConnected, false);
	} finally {
		grid.dispose();
		dom.window.close();
	}
});

test('Grid only maximizes an arrangement containing multiple views', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const view = new TestView(dom.window.document);
	const grid = new Grid(dom.window.document.body, { type: 'leaf', view, size: 100 });
	try {
		assert.throws(() => grid.maximizeView(view), /at least two views/);
		assert.equal(grid.hasMaximizedView(), false);
	} finally {
		grid.dispose();
		dom.window.close();
	}
});

test('Grid rotates nested splits while retaining views, hidden sizes and focus', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const navigation = new SerializableTestView(dom.window.document, 'navigation');
	const editor = new SerializableTestView(dom.window.document, 'editor');
	const preview = new SerializableTestView(dom.window.document, 'preview');
	const input = dom.window.document.createElement('textarea');
	input.value = 'unsaved document';
	editor.element.append(input);
	const grid = new SerializableGrid(dom.window.document.body, {
		type: 'branch', orientation: Orientation.HORIZONTAL, size: 1000, children: [
			{ type: 'leaf', view: navigation, size: 250 },
			{
				type: 'branch', orientation: Orientation.VERTICAL, size: 750, children: [
					{ type: 'leaf', view: editor, size: 200 },
					{ type: 'leaf', view: preview, size: 400 },
				],
			},
		],
	});
	try {
		grid.layout(1000, 600);
		input.focus();
		input.setSelectionRange(3, 9);
		editor.element.scrollTop = 73;
		grid.orientation = Orientation.VERTICAL;
		assert.equal(grid.orientation, Orientation.VERTICAL);
		assert.deepEqual(grid.getViewSize(navigation), { width: 1000, height: 150 });
		assert.ok(Math.abs(grid.getViewSize(editor).width - 1000 / 3) < 0.001);
		assert.equal(grid.getViewSize(editor).height, 450);
		assert.ok(Math.abs(grid.getViewSize(preview).width - 2000 / 3) < 0.001);
		assert.equal(preview.bounds?.top, 150);
		assert.ok(Math.abs(preview.bounds!.left - 1000 / 3) < 0.001);
		assert.equal(dom.window.document.activeElement, input);
		grid.orientation = Orientation.HORIZONTAL;
		assert.deepEqual(grid.getViewSize(navigation), { width: 250, height: 600 });
		assert.equal(grid.getViewSize(editor).width, 750);
		assert.ok(Math.abs(grid.getViewSize(editor).height - 200) < 0.001);
		assert.equal(grid.getViewSize(preview).width, 750);
		assert.ok(Math.abs(grid.getViewSize(preview).height - 400) < 0.001);

		grid.setViewVisible(preview, false);
		grid.orientation = Orientation.VERTICAL;
		assert.equal(grid.isViewVisible(preview), false);
		assert.ok(Math.abs(grid.getViewSize(preview).width - 2000 / 3) < 0.001);
		grid.orientation = Orientation.HORIZONTAL;
		assert.equal(grid.isViewVisible(preview), false);
		assert.equal(grid.getViewSize(preview).width, 750);
		assert.ok(Math.abs(grid.getViewSize(preview).height - 400) < 0.001);
		assert.deepEqual(grid.getViewSize(editor), { width: 750, height: 600 });
		assert.equal(dom.window.document.activeElement, input);
		assert.deepEqual([input.selectionStart, input.selectionEnd, editor.element.scrollTop], [3, 9, 73]);
		assert.equal(input.value, 'unsaved document');

		grid.maximizeView(editor);
		grid.orientation = Orientation.HORIZONTAL;
		assert.equal(grid.isViewMaximized(editor), true, 'setting the current orientation leaves maximization intact');
		grid.orientation = Orientation.VERTICAL;
		assert.equal(grid.hasMaximizedView(), false);
		assert.equal(grid.isViewVisible(navigation), true);
		assert.equal(grid.isViewVisible(editor), true);
		assert.equal(grid.isViewVisible(preview), false);
	} finally {
		grid.dispose();
		dom.window.close();
	}
});

test('Grid accepts an orientation before its first layout and ignores unchanged assignments', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const editor = new TestView(dom.window.document);
	const preview = new TestView(dom.window.document);
	const grid = new Grid(dom.window.document.body, {
		type: 'branch', orientation: Orientation.HORIZONTAL, size: 1, children: [
			{ type: 'leaf', view: editor, size: 600 },
			{ type: 'leaf', view: preview, size: 200, visible: false },
		],
	});
	try {
		let changes = 0;
		grid.onDidChange(() => changes++);
		grid.orientation = Orientation.VERTICAL;
		assert.equal(changes, 1);
		grid.orientation = Orientation.VERTICAL;
		assert.equal(changes, 1);
		grid.layout(800, 600);
		assert.deepEqual(grid.getViewSize(editor), { width: 800, height: 600 });
		assert.equal(grid.isViewVisible(preview), false);
		assert.ok(Number.isFinite(grid.getViewSize(preview).height));
		grid.setViewVisible(preview, true);
		assert.equal(changes, 2, 'revealing a view publishes one completed Grid change');
		grid.setViewVisible(preview, false);
		assert.equal(changes, 3, 'hiding a view publishes one completed Grid change');
	} finally {
		grid.dispose();
		dom.window.close();
	}
});

test('Grid relays completed nested sash gestures and resets independently of code-driven changes', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const { GridView } = await import('../../browser/ui/grid/gridview.js');
	const navigation = new TestView(dom.window.document);
	const editor = new TestView(dom.window.document);
	const preview = new TestView(dom.window.document);
	const gridview = new GridView(dom.window.document.body, {
		type: 'branch', orientation: Orientation.HORIZONTAL, size: 600, children: [
			{ type: 'leaf', view: navigation, size: 200 },
			{
				type: 'branch', orientation: Orientation.VERTICAL, size: 400, children: [
					{ type: 'leaf', view: editor, size: 180 },
					{ type: 'leaf', view: preview, size: 220 },
				],
			},
		],
	});
	using grid = new Grid(gridview);
	try {
		grid.layout(600, 400);
		let completed = 0;
		let resets = 0;
		const resetLocations: (readonly number[])[] = [];
		grid.onDidSashChange(() => completed++);
		gridview.onDidSashReset(location => resetLocations.push(location));
		grid.onDidSashReset(() => {
			resets++;
			assert.equal(grid.getViewSize(editor).height, grid.getViewSize(preview).height, 'reset is applied before notifying consumers');
		});
		const staleSash = grid.element.querySelector<HTMLElement>('.ash-sash-horizontal')!;
		grid.resizeView(editor, { width: 400, height: 170 });
		grid.setViewVisible(preview, false);
		grid.setViewVisible(preview, true);
		grid.orientation = Orientation.VERTICAL;
		grid.orientation = Orientation.HORIZONTAL;
		staleSash.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown' }));
		assert.equal(completed, 0, 'code changes and disposed tree listeners never report user resizing');
		assert.equal(resets, 0);
		const sash = grid.element.querySelector<HTMLElement>('.ash-sash-horizontal')!;
		sash.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 170 }));
		dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientY: 190 }));
		assert.equal(completed, 0);
		dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientY: 190 }));
		assert.equal(completed, 1);
		sash.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.equal(completed, 2);
		sash.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
		assert.equal(completed, 2);
		assert.equal(resets, 1);
		assert.deepEqual(resetLocations, [[1, 0]]);
	} finally {
		grid.dispose();
		dom.window.close();
	}
});
