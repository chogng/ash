import { FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { type IMouseWheelEvent } from '../../../../base/browser/mouseEvent.js';
import { SmoothScrollableElement, type IOverviewRulerLayoutInfo } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { type ScrollableElementChangeOptions } from '../../../../base/browser/ui/scrollbar/scrollableElementOptions.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type RestrictedRenderingContext } from '../../view/renderingContext.js';
import { PartFingerprint, PartFingerprints, ViewPart } from '../../view/viewPart.js';

/** Connects editor configuration and layout to the shared scrollbar controls. */
export class EditorScrollbar extends ViewPart {
	private readonly scrollbar: SmoothScrollableElement;
	private readonly domNode: FastDomNode<HTMLElement>;

	constructor(
		context: ViewContext,
		linesContent: FastDomNode<HTMLElement>,
		viewDomNode: FastDomNode<HTMLElement>,
		overflowGuardDomNode: FastDomNode<HTMLElement>,
	) {
		super(context);
		this.scrollbar = this._register(new SmoothScrollableElement(linesContent.domNode, {
			...this.readOptions(),
			lazyRender: true,
			listenOnDomNode: overflowGuardDomNode.domNode,
		}, context.viewLayout.getScrollable()));
		this.domNode = new FastDomNode(this.scrollbar.getDomNode());
		PartFingerprints.write(this.domNode, PartFingerprint.ScrollableElement);
		this.domNode.domNode.dataset.colorScheme = context.theme.type;
		this.domNode.domNode.setAttribute('aria-label', viewDomNode.domNode.getAttribute('aria-label') ?? 'Editor content');
	}

	public getDomNode(): FastDomNode<HTMLElement> { return this.domNode; }

	public getOverviewRulerLayoutInfo(): IOverviewRulerLayoutInfo {
		return this.scrollbar.getOverviewRulerLayoutInfo();
	}

	public delegateVerticalScrollbarPointerDown(event: PointerEvent): void {
		this.scrollbar.delegateVerticalScrollbarPointerDown(event);
	}

	public delegateScrollFromMouseWheelEvent(event: IMouseWheelEvent): void {
		this.scrollbar.delegateScrollFromMouseWheelEvent(event);
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		if (event.hasChanged(EditorOption.scrollbar) || event.hasChanged(EditorOption.mouseWheelScrollSensitivity)
			|| event.hasChanged(EditorOption.fastScrollSensitivity) || event.hasChanged(EditorOption.scrollPredominantAxis)
			|| event.hasChanged(EditorOption.smoothScrolling)) {
			this.scrollbar.updateOptions(this.readOptions());
		}
		return true;
	}

	public override onScrollChanged(_event: viewEvents.ViewScrollChangedEvent): boolean { return true; }

	public override onThemeChanged(event: viewEvents.ViewThemeChangedEvent): boolean {
		this.domNode.domNode.dataset.colorScheme = event.theme.colorScheme;
		return true;
	}

	public render(_context: RestrictedRenderingContext): void {
		this.scrollbar.renderNow();
	}

	private readOptions(): ScrollableElementChangeOptions {
		const options = this._context.configuration.options;
		const scrollbar = options.get(EditorOption.scrollbar);
		return {
			horizontal: scrollbar.horizontal,
			vertical: scrollbar.vertical,
			horizontalScrollbarSize: scrollbar.horizontalScrollbarSize,
			verticalScrollbarSize: scrollbar.verticalScrollbarSize,
			horizontalSliderSize: scrollbar.horizontalSliderSize,
			verticalSliderSize: scrollbar.verticalSliderSize,
			scrollByPage: scrollbar.scrollByPage,
			handleMouseWheel: scrollbar.handleMouseWheel,
			alwaysConsumeMouseWheel: scrollbar.alwaysConsumeMouseWheel,
			mouseWheelScrollSensitivity: options.get(EditorOption.mouseWheelScrollSensitivity),
			fastScrollSensitivity: options.get(EditorOption.fastScrollSensitivity),
			scrollPredominantAxis: options.get(EditorOption.scrollPredominantAxis),
			mouseWheelSmoothScroll: options.get(EditorOption.smoothScrolling) === true,
		};
	}
}
