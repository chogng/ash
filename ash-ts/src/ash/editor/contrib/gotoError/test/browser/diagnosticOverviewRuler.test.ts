import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { OverviewRulerZone } from '../../../../common/viewModel/overviewZoneManager.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { type TextMeasurer } from '../../../../common/viewModel.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
})) Object.defineProperty(globalThis, name, { configurable: true, value });

const { TestView: View } = await import('../../../../test/browser/viewModel/testViewModel.js');

suiteTeardown(() => browserEnvironment.window.close());

test('OverviewRuler projects standard zones through its canvas and layout API', () => {
	const paint: { readonly fill: string; readonly top: number; readonly height: number }[] = [];
	browserEnvironment.window.HTMLCanvasElement.prototype.getContext = function () {
		const context = {
			fillStyle: '',
			clearRect(): void {},
			beginPath(): void {},
			moveTo(): void {},
			lineTo(): void {},
			stroke(): void {},
			fillRect(_left: number, top: number, _width: number, height: number): void {
				paint.push({ fill: String(context.fillStyle), top, height });
			},
		};
		return context as unknown as CanvasRenderingContext2D;
	} as unknown as typeof browserEnvironment.window.HTMLCanvasElement.prototype.getContext;
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('one\ntwo\nthree\nfour');
	using view = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	view.layout({ width: 240, height: 80 });
	using ruler = view.createOverviewRuler('test-overview-ruler');
	container.append(ruler.getDomNode());
	ruler.setLayout({ top: 2, right: 3, width: 12, height: 80 });
	ruler.setZones([
		new OverviewRulerZone(2, 2, 0, '#cca700'),
		new OverviewRulerZone(4, 4, 0, '#f48771'),
	]);

	const canvas = ruler.getDomNode() as HTMLCanvasElement;
	assert.equal(canvas.className, 'test-overview-ruler');
	assert.equal(canvas.style.top, '2px');
	assert.equal(canvas.style.right, '3px');
	assert.equal(canvas.style.width, '12px');
	assert.equal(canvas.style.height, '80px');
	assert.deepEqual(paint.map(entry => entry.fill).slice(-2), ['#cca700', '#f48771']);
	assert.equal(paint.slice(-2).every(entry => entry.height >= 4), true);
	dom.window.close();
});

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 24;
	readonly contentLeftPadding = 12;
	refresh(): boolean { return false; }
	measureLineWidth(text: string): number { return [...text].length * 10; }
}
