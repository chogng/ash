import './media/designCanvas.css';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { StandardWheelEvent } from '../../../../base/browser/mouseEvent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getLxiconDefinition } from '../../../../base/common/lxiconsUtil.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { foreground } from '../../../../platform/theme/common/colors/baseColors.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { ISessionsPageView } from '../../../browser/pages.js';
import { DesignConfiguration } from '../common/designConfiguration.js';

const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
// Trackpad pinch and Ctrl+wheel both arrive as ctrl-modified wheel deltas in CSS pixels.
const WHEEL_ZOOM_SENSITIVITY = 0.005;
const KEYBOARD_ZOOM_FACTOR = 1.2;
const KEYBOARD_PAN_DISTANCE = 60;

/** Infinite pan and zoom surface shown as the Design page's default content. */
export class DesignCanvasView extends Disposable implements ISessionsPageView {
	readonly domNode: HTMLElement;

	private scale = 1;
	private panX = 0;
	private panY = 0;
	private isPanning = false;
	private lastPointerX = 0;
	private lastPointerY = 0;
	private dimension: IDimension = { width: 0, height: 0 };
	private readonly viewport: HTMLElement;
	private readonly world: HTMLElement;

	constructor(
		container: HTMLElement,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService configurationService: IConfigurationService,
		@IThemeService private readonly themeService: IThemeService,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'section', {
			className: 'ash-sessions-design-view',
			attributes: { role: 'region', 'aria-label': localize('sessions.design.canvas', 'Design canvas'), tabindex: '0' },
		});
		this.viewport = h(ownerDocument, 'div', { className: 'ash-sessions-design-viewport' });
		this.world = h(ownerDocument, 'div', { className: 'ash-sessions-design-world' });
		this.viewport.append(this.world);
		this.domNode.append(this.viewport);
		const scopedContext = this._register(contextKeys.createScoped(this.domNode));
		scopedContext.createKey('sessionsDesignCanvasFocused', true);
		this.updatePointerCursor();
		this.domNode.classList.toggle('pointer-cursor', configurationService.getValue<boolean>(DesignConfiguration.usePointerCursor));
		this._register(themeService.onDidColorThemeChange(() => this.updatePointerCursor()));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(DesignConfiguration.usePointerCursor)) {
				this.domNode.classList.toggle('pointer-cursor', configurationService.getValue<boolean>(DesignConfiguration.usePointerCursor));
			}
		}));

		this._register(addDisposableListener(this.viewport, 'wheel', (browserEvent: WheelEvent) => this.handleWheel(browserEvent), { passive: false }));
		this._register(addDisposableListener(this.viewport, 'pointerdown', (event: PointerEvent) => this.handlePointerDown(event)));
		this._register(addDisposableListener(this.viewport, 'pointermove', (event: PointerEvent) => this.handlePointerMove(event)));
		this._register(addDisposableListener(this.viewport, 'pointerup', (event: PointerEvent) => this.handlePointerEnd(event)));
		this._register(addDisposableListener(this.viewport, 'pointercancel', (event: PointerEvent) => this.handlePointerEnd(event)));
		this._register(addDisposableListener(this.domNode, 'keydown', event => this.handleKeyDown(event)));
		this.applyTransform();
	}

	public focus(): void {
		this.domNode.focus();
	}

	public layout(dimension: IDimension): void {
		this.dimension = dimension;
	}

	private updatePointerCursor(): void {
		const color = this.themeService.getColorTheme().getColorCss(foreground)!;
		const svg = getLxiconDefinition(Lxicon.cursor.id)!().replace('<svg ', '<svg width="24" height="24" ').replaceAll('#000', color);
		// The hotspot follows the artwork's tip at (3.5, 3) in its 16-unit viewBox.
		this.domNode.style.setProperty('--ash-sessions-design-pointer-cursor', `url("data:image/svg+xml,${encodeURIComponent(svg)}") 5 4, default`);
	}

	private handleWheel(browserEvent: WheelEvent): void {
		const wheel = new StandardWheelEvent(browserEvent);
		if (wheel.ctrlKey || wheel.metaKey) {
			const bounds = this.viewport.getBoundingClientRect();
			this.zoomAt(wheel.browserEvent.clientX - bounds.left, wheel.browserEvent.clientY - bounds.top, Math.exp(-wheel.deltaY * WHEEL_ZOOM_SENSITIVITY));
		}
		else {
			this.panBy(-wheel.deltaX, -wheel.deltaY);
		}
		wheel.stop();
	}

	private handlePointerDown(event: PointerEvent): void {
		if (event.button !== 0 || !event.isPrimary) return;
		this.isPanning = true;
		this.lastPointerX = event.clientX;
		this.lastPointerY = event.clientY;
		this.viewport.setPointerCapture?.(event.pointerId);
		this.domNode.classList.add('panning');
	}

	private handlePointerMove(event: PointerEvent): void {
		if (!this.isPanning) return;
		this.panBy(event.clientX - this.lastPointerX, event.clientY - this.lastPointerY);
		this.lastPointerX = event.clientX;
		this.lastPointerY = event.clientY;
	}

	private handlePointerEnd(event: PointerEvent): void {
		if (!this.isPanning) return;
		this.isPanning = false;
		this.viewport.releasePointerCapture?.(event.pointerId);
		this.domNode.classList.remove('panning');
	}

	private handleKeyDown(event: KeyboardEvent): void {
		switch (event.key) {
			case 'ArrowLeft': this.panBy(KEYBOARD_PAN_DISTANCE, 0); break;
			case 'ArrowRight': this.panBy(-KEYBOARD_PAN_DISTANCE, 0); break;
			case 'ArrowUp': this.panBy(0, KEYBOARD_PAN_DISTANCE); break;
			case 'ArrowDown': this.panBy(0, -KEYBOARD_PAN_DISTANCE); break;
			case '=':
			case '+': this.zoomAtCenter(KEYBOARD_ZOOM_FACTOR); break;
			case '-':
			case '_': this.zoomAtCenter(1 / KEYBOARD_ZOOM_FACTOR); break;
			case '0': this.resetView(); break;
			default: return;
		}
		event.preventDefault();
	}

	private panBy(deltaX: number, deltaY: number): void {
		this.panX += deltaX;
		this.panY += deltaY;
		this.applyTransform();
	}

	private zoomAt(centerX: number, centerY: number, factor: number): void {
		const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
		if (nextScale === this.scale) return;
		const ratio = nextScale / this.scale;
		// screen = world * scale + pan, so anchoring pan at the cursor keeps its world point fixed.
		this.panX = centerX - (centerX - this.panX) * ratio;
		this.panY = centerY - (centerY - this.panY) * ratio;
		this.scale = nextScale;
		this.applyTransform();
	}

	private zoomAtCenter(factor: number): void {
		this.zoomAt(this.dimension.width / 2, this.dimension.height / 2, factor);
	}

	private resetView(): void {
		this.scale = 1;
		this.panX = 0;
		this.panY = 0;
		this.applyTransform();
	}

	private applyTransform(): void {
		this.world.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
		this.viewport.style.setProperty('--ash-sessions-design-pan-x', `${this.panX}px`);
		this.viewport.style.setProperty('--ash-sessions-design-pan-y', `${this.panY}px`);
		this.viewport.style.setProperty('--ash-sessions-design-scale', `${this.scale}`);
	}
}
