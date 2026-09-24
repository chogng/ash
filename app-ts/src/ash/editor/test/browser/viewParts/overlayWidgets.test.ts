import { h } from '../../../../base/browser/dom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../../base/common/event.js';
import { OverlayWidgetPositionPreference, type IOverlayWidget, type IOverlayWidgetPosition } from '../../../browser/editorBrowser.js';
import { ViewOverlayWidgets } from '../../../browser/viewParts/overlayWidgets/overlayWidgets.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type ViewConfigurationChangedEvent } from '../../../common/viewEvents.js';

test('ViewOverlayWidgets reports only position changes and owns widget DOM lifetime', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const host = dom.window.document.querySelector<HTMLElement>('main')!;
	const minimumWidths: number[] = [];
	let rendered = 0;
	let minimumWidth = 40;
	const configuration = { allowOverflow: true, fixedOverflowWidgets: false };
	const layout = new Emitter<void>();
	const initial: IOverlayWidgetPosition = { preference: OverlayWidgetPositionPreference.TOP_RIGHT_CORNER };
	const node = h(dom.window.document, 'section');
	const widget: IOverlayWidget = {
		allowEditorOverflow: true,
		onDidLayout: layout.event,
		getId: () => 'test.overlay',
		getDomNode: () => node,
		getPosition: () => initial,
		getMinContentWidthInPx: () => minimumWidth,
	};
	const overlays = new ViewOverlayWidgets(testViewContext(configuration, minimumWidths), {
		viewDomNode: host,
		requestRender: () => rendered += 1,
	});

	overlays.addWidget(widget);
	assert.equal(node.parentElement, overlays.overflowingOverlayWidgetsDomNode.domNode);
	assert.equal(overlays.setWidgetPosition(widget, initial), false);
	assert.equal(rendered, 0);
	configuration.allowOverflow = false;
	overlays.onConfigurationChanged({} as ViewConfigurationChangedEvent);
	assert.equal(node.parentElement, overlays.getDomNode().domNode);
	assert.equal(node.style.position, 'absolute');
	configuration.allowOverflow = true;
	configuration.fixedOverflowWidgets = true;
	overlays.onConfigurationChanged({} as ViewConfigurationChangedEvent);
	assert.equal(node.parentElement, overlays.overflowingOverlayWidgetsDomNode.domNode);
	assert.equal(node.style.position, 'fixed');

	minimumWidth = 64;
	assert.equal(overlays.setWidgetPosition(widget, { preference: OverlayWidgetPositionPreference.TOP_RIGHT_CORNER }), false);
	assert.equal(minimumWidths.at(-1), 64);
	assert.equal(overlays.setWidgetPosition(widget, { preference: { top: 8, left: 13 }, stackOrdinal: 2 }), true);
	assert.equal(overlays.setWidgetPosition(widget, { preference: { top: 8, left: 13 }, stackOrdinal: 2 }), false);

	layout.fire();
	assert.equal(rendered, 1);
	overlays.removeWidget(widget);
	assert.equal(node.isConnected, false);
	assert.equal(minimumWidths.at(-1), 0);
	overlays.dispose();
	layout.dispose();
	dom.window.close();
});

function testViewContext(configuration: { allowOverflow: boolean; fixedOverflowWidgets: boolean }, minimumWidths: number[]): ViewContext {
	return {
		configuration: {
			options: {
				get(option: EditorOption) {
					if (option === EditorOption.allowOverflow) return configuration.allowOverflow;
					if (option === EditorOption.fixedOverflowWidgets) return configuration.fixedOverflowWidgets;
					if (option === EditorOption.layoutInfo) {
						return {
							verticalScrollbarWidth: 12,
							horizontalScrollbarHeight: 10,
							width: 800,
							height: 600,
							minimap: { minimapWidth: 0 },
						};
					}
					throw new RangeError(`Unexpected editor option: ${option}`);
				},
			},
		},
		viewLayout: { setOverlayWidgetsMinWidth: (width: number) => minimumWidths.push(width) },
		addEventHandler() {},
		removeEventHandler() {},
	} as unknown as ViewContext;
}
