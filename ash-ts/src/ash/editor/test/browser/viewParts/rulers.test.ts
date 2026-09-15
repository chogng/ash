import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { darkColorTheme, lightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { EditorTheme } from '../../../common/editorTheme.js';
import { EditorOption, type IRulerOption } from '../../../common/config/editorOptions.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type ViewConfigurationChangedEvent, type ViewScrollChangedEvent, type ViewThemeChangedEvent } from '../../../common/viewEvents.js';
import { type IObjectCollectionBufferEntry } from '../../../browser/gpu/objectCollectionBuffer.js';
import { type RectangleRendererEntrySpec } from '../../../browser/gpu/rectangleRenderer.js';
import { type ViewGpuContext } from '../../../browser/gpu/viewGpuContext.js';
import { type RestrictedRenderingContext } from '../../../browser/view/renderingContext.js';
import { observableValue } from '../../../../base/common/observable.js';
import { Rulers } from '../../../browser/viewParts/rulers/rulers.js';
import { RulersGpu } from '../../../browser/viewParts/rulersGpu/rulersGpu.js';

test('Rulers reads canonical configuration and reuses DOM nodes', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const state = configurationState([
		{ column: 4, color: null },
		{ column: 8, color: '#ff0000' },
	], 8);
	const rulers = new Rulers(testViewContext(state), {
		host: dom.window.document.querySelector('main')!,
		readTextLeft: () => 20,
	});
	dom.window.document.querySelector('main')!.append(rulers.domNode.domNode);

	rulers.render(renderingContext(640, 1_200));
	const initial = [...rulers.domNode.domNode.querySelectorAll<HTMLElement>('.stanza-editor-ruler')];
	assert.equal(rulers.domNode.domNode.ownerDocument, dom.window.document);
	assert.equal(rulers.domNode.domNode.getAttribute('role'), 'presentation');
	assert.equal(rulers.domNode.domNode.getAttribute('aria-hidden'), 'true');
	assert.deepEqual(initial.map(node => node.style.left), ['52px', '84px']);
	assert.deepEqual(initial.map(node => node.style.height), ['1200px', '1200px']);
	assert.deepEqual(initial.map(node => node.style.getPropertyValue('--stanza-editor-ruler-color')), ['', '#ff0000']);

	state.rulers = [
		{ column: 5, color: '#00ff00' },
		{ column: 12, color: null },
		{ column: 20, color: null },
	];
	state.typicalHalfwidthCharacterWidth = 10;
	assert.equal(rulers.onConfigurationChanged(configurationChange(EditorOption.rulers, EditorOption.fontInfo)), true);
	rulers.render(renderingContext(800, 1_500));
	const expanded = [...rulers.domNode.domNode.querySelectorAll<HTMLElement>('.stanza-editor-ruler')];
	assert.strictEqual(expanded[0], initial[0]);
	assert.strictEqual(expanded[1], initial[1]);
	assert.deepEqual(expanded.map(node => node.style.left), ['70px', '140px', '220px']);
	assert.equal(expanded[1]!.style.getPropertyValue('--stanza-editor-ruler-color'), '');

	state.rulers = [{ column: 3, color: null }];
	rulers.onConfigurationChanged(configurationChange(EditorOption.rulers));
	rulers.render(renderingContext(500, 2_000_000));
	assert.equal(rulers.domNode.domNode.querySelectorAll('.stanza-editor-ruler').length, 1);
	assert.strictEqual(rulers.domNode.domNode.querySelector('.stanza-editor-ruler'), initial[0]);
	assert.equal((initial[0] as HTMLElement).style.height, '1000000px');
	assert.equal(rulers.onConfigurationChanged(configurationChange(EditorOption.lineHeight)), false);
	assert.equal(rulers.onScrollChanged({ scrollHeightChanged: true, scrollWidthChanged: false } as ViewScrollChangedEvent), true);

	rulers.dispose();
	assert.equal(dom.window.document.querySelector('main')!.children.length, 0);
	dom.window.close();
});

test('RulersGpu updates and disposes stable rectangle entries', () => {
	const state = configurationState([
		{ column: 4, color: null },
		{ column: 8, color: '#ff000080' },
	], 7);
	const context = testViewContext(state);
	const entries: TestRectangleEntry[] = [];
	const gpuContext = {
		devicePixelRatio: observableValue('devicePixelRatio', 2),
		rectangleRenderer: {
			register: (...data: number[]) => {
				const entry = new TestRectangleEntry(data);
				entries.push(entry);
				return entry;
			},
		},
	} as unknown as ViewGpuContext;
	const rulers = new RulersGpu(context, gpuContext);

	rulers.render(renderingContext(640, 1_200));
	assert.equal(entries.length, 2);
	assert.deepEqual(entries[0]!.data.slice(0, 4), [56, 0, 2, Number.MAX_SAFE_INTEGER]);
	assert.deepEqual(entries[0]!.data.slice(4), [90 / 255, 90 / 255, 90 / 255, 1]);
	assert.deepEqual(entries[1]!.data.slice(4), [1, 0, 0, 0.502]);
	rulers.render(renderingContext(640, 1_200));
	assert.deepEqual(entries.map(entry => entry.rawUpdateCount), [0, 0]);

	state.rulers = [{ column: 2, color: null }];
	state.typicalHalfwidthCharacterWidth = 5;
	assert.equal(rulers.onConfigurationChanged(configurationChange(EditorOption.rulers, EditorOption.fontInfo)), true);
	rulers.render(renderingContext(640, 1_200));
	assert.equal(entries.length, 2);
	assert.deepEqual(entries[0]!.data.slice(0, 4), [20, 0, 2, Number.MAX_SAFE_INTEGER]);
	assert.equal(entries[1]!.disposed, true);

	context.theme.update(lightColorTheme);
	rulers.onThemeChanged({ theme: lightColorTheme } as ViewThemeChangedEvent);
	assert.deepEqual(entries[0]!.data.slice(4), [211 / 255, 211 / 255, 211 / 255, 1]);

	rulers.dispose();
	assert.equal(entries[0]!.disposed, true);
});

class TestRectangleEntry implements IObjectCollectionBufferEntry<RectangleRendererEntrySpec> {
	public disposed = false;
	public data: number[];
	public rawUpdateCount = 0;

	constructor(data: ArrayLike<number>) {
		this.data = Array.from(data);
	}

	public setRaw(data: ArrayLike<number>): void {
		this.data = Array.from(data);
		this.rawUpdateCount += 1;
	}

	public set(propertyName: RectangleRendererEntrySpec[number]['name'], value: number): void {
		this.data[propertyIndex(propertyName)] = value;
	}

	public get(propertyName: RectangleRendererEntrySpec[number]['name']): number {
		return this.data[propertyIndex(propertyName)]!;
	}

	public dispose(): void {
		this.disposed = true;
	}

	public [Symbol.dispose](): void {
		this.dispose();
	}
}

function propertyIndex(name: RectangleRendererEntrySpec[number]['name']): number {
	return ['x', 'y', 'width', 'height', 'red', 'green', 'blue', 'alpha'].indexOf(name);
}

function configurationState(rulers: readonly IRulerOption[], typicalHalfwidthCharacterWidth: number): {
	rulers: readonly IRulerOption[];
	typicalHalfwidthCharacterWidth: number;
} {
	return { rulers, typicalHalfwidthCharacterWidth };
}

function testViewContext(state: ReturnType<typeof configurationState>): ViewContext {
	return {
		configuration: {
			options: {
				get(option: EditorOption) {
					if (option === EditorOption.rulers) return state.rulers;
					if (option === EditorOption.fontInfo) return { typicalHalfwidthCharacterWidth: state.typicalHalfwidthCharacterWidth };
					throw new RangeError(`Unexpected editor option: ${option}`);
				},
			},
		},
		theme: new EditorTheme(darkColorTheme),
		addEventHandler() {},
		removeEventHandler() {},
	} as unknown as ViewContext;
}

function configurationChange(...changed: EditorOption[]): ViewConfigurationChangedEvent {
	return { hasChanged: (option: EditorOption) => changed.includes(option) } as ViewConfigurationChangedEvent;
}

function renderingContext(scrollWidth: number, scrollHeight: number): RestrictedRenderingContext {
	return { scrollWidth, scrollHeight } as RestrictedRenderingContext;
}
