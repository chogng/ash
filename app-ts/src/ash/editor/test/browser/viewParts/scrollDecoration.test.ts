import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { EditorOption, RenderMinimap, type EditorLayoutInfo, type InternalEditorScrollbarOptions } from '../../../common/config/editorOptions.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type ViewConfigurationChangedEvent, type ViewScrollChangedEvent } from '../../../common/viewEvents.js';
import { type RestrictedRenderingContext } from '../../../browser/view/renderingContext.js';
import { ScrollDecorationViewPart } from '../../../browser/viewParts/scrollDecoration/scrollDecoration.js';

test('ScrollDecorationViewPart follows layout and scrollbar configuration', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const state = configurationState();
	const scrollDecoration = new ScrollDecorationViewPart(testViewContext(state), dom.window.document.querySelector('main')!);
	const domNode = scrollDecoration.getDomNode().domNode;
	dom.window.document.querySelector('main')!.append(domNode);

	assert.equal(domNode.getAttribute('role'), 'presentation');
	assert.equal(domNode.getAttribute('aria-hidden'), 'true');
	scrollDecoration.render(renderingContext({ scrollLeft: 15, scrollTop: 0, scrollHeight: 300, viewportHeight: 100 }));
	assert.equal(domNode.style.width, '500px');
	assert.equal(domNode.style.height, '100px');
	assert.equal(domNode.style.transform, 'translate3d(15px, 0px, 0)');
	assert.equal(shadow(scrollDecoration, 'top').classList.contains('visible'), false);
	assert.equal(shadow(scrollDecoration, 'bottom').classList.contains('visible'), true);

	state.layoutInfo = layoutInfo({
		width: 500,
		verticalScrollbarWidth: 14,
		minimap: { renderMinimap: RenderMinimap.Blocks, minimapLeft: 400, minimapWidth: 80 },
	});
	state.scrollbar = { useShadows: false } as InternalEditorScrollbarOptions;
	assert.equal(scrollDecoration.onConfigurationChanged(configurationChange(EditorOption.layoutInfo, EditorOption.scrollbar)), true);
	scrollDecoration.render(renderingContext({ scrollTop: 50, scrollHeight: 300, viewportHeight: 100 }));
	assert.equal(domNode.style.width, '486px');
	assert.equal(shadow(scrollDecoration, 'top').classList.contains('visible'), false);
	assert.equal(shadow(scrollDecoration, 'bottom').classList.contains('visible'), false);

	state.scrollbar = { useShadows: true } as InternalEditorScrollbarOptions;
	assert.equal(scrollDecoration.onConfigurationChanged(configurationChange(EditorOption.scrollbar)), true);
	scrollDecoration.render(renderingContext({ scrollTop: 50, scrollHeight: 300, viewportHeight: 100 }));
	assert.equal(shadow(scrollDecoration, 'top').classList.contains('visible'), true);
	assert.equal(shadow(scrollDecoration, 'bottom').classList.contains('visible'), true);
	assert.equal(scrollDecoration.onConfigurationChanged(configurationChange(EditorOption.scrollbar)), false);
	assert.equal(scrollDecoration.onConfigurationChanged(configurationChange(EditorOption.lineHeight)), false);
	assert.equal(scrollDecoration.onScrollChanged(scrollChange({ scrollLeftChanged: true })), true);
	assert.equal(scrollDecoration.onScrollChanged(scrollChange({ scrollWidthChanged: true })), false);

	scrollDecoration.dispose();
	assert.equal(dom.window.document.querySelector('main')!.children.length, 0);
	dom.window.close();
});

function configurationState(): { layoutInfo: EditorLayoutInfo; scrollbar: InternalEditorScrollbarOptions } {
	return {
		layoutInfo: layoutInfo({ width: 500 }),
		scrollbar: { useShadows: true } as InternalEditorScrollbarOptions,
	};
}

function testViewContext(state: ReturnType<typeof configurationState>): ViewContext {
	return {
		configuration: {
			options: {
				get(option: EditorOption) {
					if (option === EditorOption.layoutInfo) return state.layoutInfo;
					if (option === EditorOption.scrollbar) return state.scrollbar;
					throw new RangeError(`Unexpected editor option: ${option}`);
				},
			},
		},
		addEventHandler() {},
		removeEventHandler() {},
	} as unknown as ViewContext;
}

function layoutInfo(options: {
	readonly width: number;
	readonly verticalScrollbarWidth?: number;
	readonly minimap?: Pick<EditorLayoutInfo['minimap'], 'renderMinimap' | 'minimapLeft' | 'minimapWidth'>;
}): EditorLayoutInfo {
	return {
		width: options.width,
		verticalScrollbarWidth: options.verticalScrollbarWidth ?? 14,
		minimap: {
			renderMinimap: RenderMinimap.None,
			minimapLeft: 0,
			minimapWidth: 0,
			...options.minimap,
		},
	} as EditorLayoutInfo;
}

function renderingContext(options: {
	readonly scrollLeft?: number;
	readonly scrollTop: number;
	readonly scrollHeight: number;
	readonly viewportHeight: number;
}): RestrictedRenderingContext {
	return {
		scrollLeft: options.scrollLeft ?? 0,
		scrollTop: options.scrollTop,
		scrollHeight: options.scrollHeight,
		viewportHeight: options.viewportHeight,
	} as RestrictedRenderingContext;
}

function configurationChange(...changed: EditorOption[]): ViewConfigurationChangedEvent {
	return { hasChanged: (option: EditorOption) => changed.includes(option) } as ViewConfigurationChangedEvent;
}

function scrollChange(changed: Partial<ViewScrollChangedEvent>): ViewScrollChangedEvent {
	return {
		scrollTopChanged: false,
		scrollLeftChanged: false,
		scrollHeightChanged: false,
		scrollWidthChanged: false,
		...changed,
	} as ViewScrollChangedEvent;
}

function shadow(scrollDecoration: ScrollDecorationViewPart, edge: 'top' | 'bottom'): HTMLElement {
	return scrollDecoration.getDomNode().domNode.querySelector<HTMLElement>(`.stanza-editor-scroll-decoration-shadow.${edge}`)!;
}
