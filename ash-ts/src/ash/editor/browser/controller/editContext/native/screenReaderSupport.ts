import { addDisposableListener } from "../../../../../base/browser/dom.js";
import { type FastDomNode } from '../../../../../base/browser/fastDomNode.js';
import { Disposable, MutableDisposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { type Event } from "../../../../../base/common/event.js";
import { type IAccessibilityService } from "../../../../../platform/accessibility/common/accessibility.js";
import { Position } from "../../../../common/core/position.js";
import { type View } from "../../../view.js";
import { RichScreenReaderContent } from "./screenReaderContentRich.js";
import { SimpleScreenReaderContent } from "./screenReaderContentSimple.js";
import { type IScreenReaderContent, type ScreenReaderContentLayout, type ScreenReaderContentState } from "./screenReaderUtils.js";
import { type BracketColorizationSource, type SemanticTokenSource } from "../../../viewParts/viewLines/viewLine.js";
import { type IEditorAriaOptions } from '../../../editorBrowser.js';
import { type RenderingContext, type RestrictedRenderingContext } from '../../../view/renderingContext.js';
import * as viewEvents from '../../../../common/viewEvents.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import { type ViewContext } from '../../../../common/viewModel/viewContext.js';
import { type EditContextViewController } from '../editContext.js';

export interface NativeScreenReaderSupportOptions {
	readonly domNode: FastDomNode<HTMLElement>;
	readonly context: ViewContext;
	readonly viewport: View;
	readonly viewController: EditContextViewController;
	/** Logical focus events from NativeEditContext; they hide the IME bridge hop. */
	readonly onDidFocus?: Event<void>;
	readonly onDidBlur?: Event<void>;
	readonly accessibilityService?: IAccessibilityService;
	readonly semanticTokenSource?: SemanticTokenSource;
	readonly bracketColorizationSource?: BracketColorizationSource;
}

/**
 * Owns the screen-reader-only projection required by native EditContext.
 *
 * The native browser buffer remains the input authority. This controller only
 * exposes a bounded, paged source-text mirror when accessibility optimization
 * is on and keeps that mirror aligned with the viewport's active cursor.
 */
export class ScreenReaderSupport extends Disposable {
	private readonly content = this._register(new MutableDisposable<NativeScreenReaderContent>());
	private rendersRichContent: boolean | undefined;
	private focused = false;
	private syncScheduled = false;

	constructor(private readonly options: NativeScreenReaderSupportOptions) {
		super();
		if (options.context.viewModel.model !== options.viewport.textModel) {
			this.dispose();
			throw new TypeError('Native screen-reader content, view model, and viewport must share one text model');
		}
		this._register(toDisposable(() => this.resetNativeScreenReaderLayout()));
		this.refreshContent();
		const element = options.domNode.domNode;
		if (options.onDidFocus) {
			this._register(options.onDidFocus(() => this.handleFocusChange(true)));
		} else {
			this._register(addDisposableListener(element, "focus", () => this.handleFocusChange(true)));
		}
		if (options.onDidBlur) {
			this._register(options.onDidBlur(() => this.handleFocusChange(false)));
		} else {
			this._register(addDisposableListener(element, "blur", () => this.handleFocusChange(false)));
		}
		this._register(addDisposableListener(element, "cut", () => this.onWillCut()));
		this._register(addDisposableListener(element, "paste", () => this.onWillPaste()));
		this._register(options.viewport.onDidChangeLayout(() => this.scheduleSynchronization()));
		if (options.semanticTokenSource) {
			this._register(options.semanticTokenSource.onDidChange(() => this.scheduleSynchronization()));
		}
		if (options.accessibilityService) {
			this._register(options.accessibilityService.onDidChangeScreenReaderOptimized(() => this.scheduleSynchronization()));
		}
		this.scheduleSynchronization();
	}

	private isEnabled(): boolean {
		return this.options.accessibilityService?.isScreenReaderOptimized() ?? false;
	}

	onWillCut(): void {
		this.content.value?.onWillCut();
	}

	onWillPaste(): void {
		this.content.value?.onWillPaste();
	}

	setAriaOptions(options: IEditorAriaOptions): void {
		const element = this.options.domNode.domNode;
		if (options.activeDescendant) {
			element.setAttribute('aria-haspopup', 'true');
			element.setAttribute('aria-autocomplete', 'list');
			element.setAttribute('aria-activedescendant', options.activeDescendant);
		} else {
			element.setAttribute('aria-haspopup', 'false');
			element.setAttribute('aria-autocomplete', 'both');
			element.removeAttribute('aria-activedescendant');
		}
		if (options.role) element.setAttribute('role', options.role);
	}

	writeScreenReaderContent(): void {
		this.synchronize();
		this.layoutContent();
	}

	onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): void {
		this.refreshContent();
		this.scheduleSynchronization();
	}

	onCursorStateChanged(_event: viewEvents.ViewCursorStateChangedEvent): void {
		this.scheduleSynchronization();
	}

	prepareRender(_context: RenderingContext): void {
		this.synchronize();
	}

	render(_context: RestrictedRenderingContext): void {
		this.layoutContent();
	}

	handleFocusChange(focused: boolean): void {
		if (this.focused === focused) return;
		this.focused = focused;
		this.content.value?.onFocusChange(focused);
		if (focused) this.scheduleSynchronization();
		else {
			this.resetNativeScreenReaderLayout();
		}
	}

	private scheduleSynchronization(): void {
		if (this.syncScheduled) return;
		this.syncScheduled = true;
		queueMicrotask(() => {
			this.syncScheduled = false;
			this.synchronize();
			this.layoutContent();
		});
	}

	private synchronize(): void {
		const content = this.content.value;
		if (!content) return;
		if (
			this.isDisposed ||
			!this.isEnabled() ||
			!this.focused ||
			this.options.viewController.compositionController.composing
		) {
			content.clear();
			this.resetNativeScreenReaderLayout();
			return;
		}
		content.updateScreenReaderContent(this.options.context.viewModel.getSelections()[0]!);
	}

	private layoutContent(): void {
		const content = this.content.value;
		if (!content) return;
		const state = content.getState();
		if (
			!state ||
			this.isDisposed ||
			!this.isEnabled() ||
			!this.focused ||
			this.options.viewController.compositionController.composing
		) {
			this.resetNativeScreenReaderLayout();
			return;
		}

		const viewportLayout = this.options.viewport.currentLayout;
		const selection = this.options.context.viewModel.getSelections()[0]!;
		const position = this.options.viewport.getPositionContentCoordinates(selection.getPosition());
		const scrollPosition = viewportLayout.scrollPosition;
		const viewportWidth = viewportLayout.viewportSize.width;
		const viewportHeight = viewportLayout.viewportSize.height;
		const cursorVisible = viewportWidth > 0 && viewportHeight > 0 &&
			position.left >= scrollPosition.left &&
			position.left <= scrollPosition.left + viewportWidth &&
			position.top >= scrollPosition.top &&
			position.top <= scrollPosition.top + viewportHeight;
		const textLeft = this.options.viewport.getPositionContentCoordinates(new Position((0) + 1, (0) + 1)).left;
		const desiredLeft = cursorVisible ? textLeft - scrollPosition.left : 0;
		const desiredTop = cursorVisible ? position.top - scrollPosition.top : 0;
		const lineHeight = Math.max(1, position.height);
		const element = this.options.domNode.domNode;
		const rootLeft = readInlinePixel(element.style.left);
		const rootTop = readInlinePixel(element.style.top);
		element.classList.add("stanza-native-screen-reader-content-active");
		content.layout({
			left: desiredLeft - rootLeft,
			top: desiredTop - rootTop,
			width: Math.max(1, viewportWidth),
			height: lineHeight,
			lineHeight,
		});
		content.updateScrollTop(selection);
	}

	private resetNativeScreenReaderLayout(): void {
		this.options.domNode.domNode.classList.remove("stanza-native-screen-reader-content-active");
	}

	private refreshContent(): void {
		const configuration = this.options.context.configuration;
		const renderRichContent = configuration.options.get(EditorOption.renderRichScreenReaderContent);
		if (this.rendersRichContent === renderRichContent) {
			this.content.value?.onConfigurationChanged(configuration.options);
			return;
		}
		const content = renderRichContent
			? new RichScreenReaderContent(
				this.options.domNode,
				this.options.context,
				this.options.viewController,
				this.options.accessibilityService,
				{
					semanticTokenSource: this.options.semanticTokenSource,
					bracketColorizationSource: this.options.bracketColorizationSource,
				},
			)
			: new SimpleScreenReaderContent(
				this.options.domNode,
				this.options.context,
				this.options.viewController,
				this.options.accessibilityService,
			);
		content.onConfigurationChanged(configuration.options);
		content.onFocusChange(this.focused);
		this.content.value = content;
		this.rendersRichContent = renderRichContent;
	}
}

interface NativeScreenReaderContent extends IScreenReaderContent {
	getState(): ScreenReaderContentState | undefined;
	clear(): void;
	layout(layout: ScreenReaderContentLayout): void;
}

function readInlinePixel(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}
