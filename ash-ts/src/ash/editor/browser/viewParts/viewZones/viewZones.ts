import { getActiveDocument } from '../../../../base/browser/dom.js';
import { createFastDomNode, type FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { isFiniteNumber } from '../../../../base/common/numbers.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Position } from '../../../common/core/position.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { type IViewWhitespaceViewportData, type IWhitespaceChangeAccessor } from '../../../common/viewModel.js';
import { type IViewZone, type IViewZoneChangeAccessor } from '../../editorBrowser.js';
import { type RenderingContext, type RestrictedRenderingContext } from '../../view/renderingContext.js';
import { ViewPart } from '../../view/viewPart.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';

interface ViewZoneData {
	readonly delegate: IViewZone;
	readonly domNode: FastDomNode<HTMLElement>;
	readonly marginDomNode: FastDomNode<HTMLElement> | null;
	isInHiddenArea: boolean;
	isVisible: boolean;
}

interface ComputedViewZoneProperties {
	readonly afterViewLineNumber: number;
	readonly heightInPixels: number;
	readonly minWidthInPixels: number;
	readonly isInHiddenArea: boolean;
}

/** Owns caller-provided DOM roots placed in reserved vertical editor space. */
export class ViewZones extends ViewPart {
	public readonly domNode: FastDomNode<HTMLElement>;
	public readonly marginDomNode: FastDomNode<HTMLElement>;
	private readonly zones = new Map<string, ViewZoneData>();
	private lineHeight: number;
	private contentWidth: number;
	private contentLeft: number;

	constructor(context: ViewContext) {
		super(context);
		const options = context.configuration.options;
		const layoutInfo = options.get(EditorOption.layoutInfo);
		this.lineHeight = options.get(EditorOption.lineHeight);
		this.contentWidth = layoutInfo.contentWidth;
		this.contentLeft = layoutInfo.contentLeft;
		const ownerDocument = getActiveDocument();
		this.domNode = createFastDomNode(ownerDocument.createElement('div'));
		this.domNode.setClassName('stanza-editor-view-zones');
		this.domNode.setPosition('absolute');
		this.domNode.setTop(0);
		this.domNode.setAttribute('role', 'presentation');
		this.domNode.setAttribute('aria-hidden', 'true');
		this.marginDomNode = createFastDomNode(ownerDocument.createElement('div'));
		this.marginDomNode.setClassName('stanza-editor-margin-view-zones');
		this.marginDomNode.setPosition('absolute');
		this.marginDomNode.setTop(0);
		this.marginDomNode.setAttribute('role', 'presentation');
		this.marginDomNode.setAttribute('aria-hidden', 'true');
		this._register(toDisposable(() => {
			for (const zone of this.zones.values()) {
				zone.domNode.domNode.remove();
				zone.marginDomNode?.domNode.remove();
			}
			this.zones.clear();
			this.domNode.domNode.remove();
			this.marginDomNode.domNode.remove();
		}));
	}

	public override dispose(): void {
		super.dispose();
		this.zones.clear();
	}

	public changeViewZones(callback: (accessor: IViewZoneChangeAccessor) => void): boolean {
		this.assertNotDisposed();
		if (typeof callback !== 'function') throw new TypeError('View zone changes require a callback');
		let zonesHaveChanged = false;
		let valid = true;
		const assertValid = (): void => {
			if (!valid) throw new Error('View zone change accessor is no longer valid');
		};
		this._context.viewModel.changeWhitespace(whitespaceAccessor => {
			const accessor: IViewZoneChangeAccessor = {
				addZone: zone => {
					assertValid();
					zonesHaveChanged = true;
					return this.addZoneData(whitespaceAccessor, zone);
				},
				removeZone: id => {
					assertValid();
					zonesHaveChanged = this.removeZone(whitespaceAccessor, id) || zonesHaveChanged;
				},
				layoutZone: id => {
					assertValid();
					zonesHaveChanged = this.layoutZone(whitespaceAccessor, id) || zonesHaveChanged;
				},
			};
			try {
				callback(accessor);
			} catch (error) {
				onUnexpectedError(error);
			} finally {
				valid = false;
			}
		});
		if (zonesHaveChanged) this.setShouldRender();
		return zonesHaveChanged;
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		const options = this._context.configuration.options;
		const layoutInfo = options.get(EditorOption.layoutInfo);
		this.lineHeight = options.get(EditorOption.lineHeight);
		this.contentWidth = layoutInfo.contentWidth;
		this.contentLeft = layoutInfo.contentLeft;
		if (event.hasChanged(EditorOption.lineHeight)) this.recomputeWhitespaceProperties();
		return true;
	}

	public override onLineMappingChanged(_event: viewEvents.ViewLineMappingChangedEvent): boolean {
		return this.recomputeWhitespaceProperties();
	}

	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean { return true; }
	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean { return true; }
	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean { return event.scrollTopChanged || event.scrollWidthChanged; }
	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean { return true; }

	public shouldSuppressMouseDownOnViewZone(id: string): boolean {
		return Boolean(this.zones.get(id)?.delegate.suppressMouseDown);
	}

	public prepareRender(_context: RenderingContext): void { }

	public render(context: RestrictedRenderingContext): void {
		const visibleWhitespaces = new Map<string, IViewWhitespaceViewportData>();
		for (const whitespace of context.viewportData.whitespaceViewportData) {
			if (this.zones.has(whitespace.id)) visibleWhitespaces.set(whitespace.id, whitespace);
		}
		let hasVisibleZone = false;
		for (const [id, zone] of this.zones) {
			const whitespace = visibleWhitespaces.get(id);
			const visible = Boolean(whitespace && whitespace.height > 0 && !zone.isInHiddenArea);
			if (!visible) {
				if (zone.isVisible) {
					zone.domNode.removeAttribute('data-visible-view-zone');
					zone.marginDomNode?.removeAttribute('data-visible-view-zone');
					zone.isVisible = false;
				}
				zone.domNode.setTop(0);
				zone.domNode.setHeight(0);
				zone.domNode.setDisplay('none');
				if (zone.marginDomNode) {
					zone.marginDomNode.setTop(0);
					zone.marginDomNode.setHeight(0);
					zone.marginDomNode.setDisplay('none');
				}
				this.safeInvoke(zone.delegate, zone.delegate.onDomNodeTop, context.getScrolledTopFromAbsoluteTop(-1_000_000));
				continue;
			}
			hasVisibleZone = true;
			const absoluteTop = whitespace!.verticalOffset;
			const top = absoluteTop - context.bigNumbersDelta;
			const height = whitespace!.height;
			zone.domNode.setDisplay('block');
			zone.domNode.setAttribute('data-visible-view-zone', 'true');
			zone.domNode.setTop(top);
			zone.domNode.setHeight(height);
			if (zone.marginDomNode) {
				zone.marginDomNode.setDisplay('block');
				zone.marginDomNode.setAttribute('data-visible-view-zone', 'true');
				zone.marginDomNode.setTop(top);
				zone.marginDomNode.setHeight(height);
			}
			zone.isVisible = true;
			this.safeInvoke(zone.delegate, zone.delegate.onDomNodeTop, context.getScrolledTopFromAbsoluteTop(absoluteTop));
		}
		if (hasVisibleZone) {
			this.domNode.setLeft(this.contentLeft);
			this.domNode.setWidth(Math.max(this.contentWidth, context.scrollWidth - this.contentLeft));
			this.marginDomNode.setWidth(this.contentLeft);
		}
	}

	private addZoneData(whitespaceAccessor: IWhitespaceChangeAccessor, zone: IViewZone): string {
		this.validateZone(zone);
		const properties = this.computeZoneProperties(zone);
		const id = whitespaceAccessor.insertWhitespace(properties.afterViewLineNumber, this.zoneOrdinal(zone), properties.heightInPixels, properties.minWidthInPixels);
		const domNode = createFastDomNode(zone.domNode);
		domNode.setPosition('absolute');
		domNode.domNode.style.width = '100%';
		domNode.setDisplay('none');
		domNode.setClassName(`${domNode.domNode.className} stanza-editor-view-zone`.trim());
		domNode.setAttribute('data-view-zone-id', id);
		this.domNode.appendChild(domNode);
		const marginDomNode = zone.marginDomNode ? createFastDomNode(zone.marginDomNode) : null;
		if (marginDomNode) {
			marginDomNode.setPosition('absolute');
			marginDomNode.domNode.style.width = '100%';
			marginDomNode.setDisplay('none');
			marginDomNode.setClassName(`${marginDomNode.domNode.className} stanza-editor-margin-view-zone`.trim());
			marginDomNode.setAttribute('data-view-zone-id', id);
			this.marginDomNode.appendChild(marginDomNode);
		}
		this.zones.set(id, { delegate: zone, domNode, marginDomNode, isInHiddenArea: properties.isInHiddenArea, isVisible: false });
		this.safeInvoke(zone, zone.onComputedHeight, properties.heightInPixels);
		return id;
	}

	private layoutZone(whitespaceAccessor: IWhitespaceChangeAccessor, id: string): boolean {
		const zone = this.zones.get(id);
		if (!zone) return false;
		this.validateZone(zone.delegate);
		const properties = this.computeZoneProperties(zone.delegate);
		zone.isInHiddenArea = properties.isInHiddenArea;
		whitespaceAccessor.changeOneWhitespace(id, properties.afterViewLineNumber, properties.heightInPixels);
		this.safeInvoke(zone.delegate, zone.delegate.onComputedHeight, properties.heightInPixels);
		return true;
	}

	private removeZone(whitespaceAccessor: IWhitespaceChangeAccessor, id: string): boolean {
		const zone = this.zones.get(id);
		if (!zone) return false;
		this.zones.delete(id);
		whitespaceAccessor.removeWhitespace(id);
		zone.domNode.domNode.remove();
		zone.marginDomNode?.domNode.remove();
		return true;
	}

	private recomputeWhitespaceProperties(): boolean {
		const existing = new Map(this._context.viewLayout.getWhitespaces().map(whitespace => [whitespace.id, whitespace]));
		let changed = false;
		this._context.viewModel.changeWhitespace(accessor => {
			for (const [id, zone] of this.zones) {
				const properties = this.computeZoneProperties(zone.delegate);
				zone.isInHiddenArea = properties.isInHiddenArea;
				const whitespace = existing.get(id);
				if (!whitespace || whitespace.afterLineNumber === properties.afterViewLineNumber && whitespace.height === properties.heightInPixels) continue;
				accessor.changeOneWhitespace(id, properties.afterViewLineNumber, properties.heightInPixels);
				this.safeInvoke(zone.delegate, zone.delegate.onComputedHeight, properties.heightInPixels);
				changed = true;
			}
		});
		return changed;
	}

	private validateZone(zone: IViewZone): void {
		if (!zone || !(zone.domNode instanceof this.domNode.domNode.ownerDocument.defaultView!.HTMLElement)) {
			throw new TypeError('Editor view zone requires a DOM root from the editor document');
		}
		if (!Number.isSafeInteger(zone.afterLineNumber) || zone.afterLineNumber < 0) {
			throw new RangeError('Editor view zone line number must be a non-negative safe integer');
		}
		if (zone.heightInPx !== undefined && (!isFiniteNumber(zone.heightInPx) || zone.heightInPx < 0)) {
			throw new RangeError('Editor view zone height must be finite and non-negative');
		}
		if (zone.heightInPx === undefined && zone.heightInLines !== undefined && (!isFiniteNumber(zone.heightInLines) || zone.heightInLines < 0)) {
			throw new RangeError('Editor view zone line height must be finite and non-negative');
		}
		if (zone.ordinal !== undefined && !isFiniteNumber(zone.ordinal)) {
			throw new RangeError('Editor view zone ordinal must be finite');
		}
		if (zone.minWidthInPx !== undefined && (!isFiniteNumber(zone.minWidthInPx) || zone.minWidthInPx < 0)) {
			throw new RangeError('Editor view zone minimum width must be finite and non-negative');
		}
	}

	private zoneHeight(zone: IViewZone): number {
		return zone.heightInPx ?? (zone.heightInLines ?? 1) * this.lineHeight;
	}

	private zoneOrdinal(zone: IViewZone): number {
		return Math.min(2_147_483_647, zone.ordinal ?? zone.afterColumn ?? 10_000);
	}

	private computeZoneProperties(zone: IViewZone): ComputedViewZoneProperties {
		const heightInPixels = this.zoneHeight(zone);
		const minWidthInPixels = zone.minWidthInPx ?? 0;
		if (zone.afterLineNumber === 0) return { afterViewLineNumber: 0, heightInPixels, minWidthInPixels, isInHiddenArea: false };
		const model = this._context.viewModel.model;
		const validAfterLineNumber = model.validatePosition(new Position(zone.afterLineNumber, 1)).lineNumber;
		const afterPosition = zone.afterColumn === undefined
			? new Position(validAfterLineNumber, model.getLineMaxColumn(validAfterLineNumber))
			: model.validatePosition(new Position(zone.afterLineNumber, zone.afterColumn));
		const beforePosition = afterPosition.column === model.getLineMaxColumn(afterPosition.lineNumber)
			? model.validatePosition(new Position(afterPosition.lineNumber + 1, 1))
			: model.validatePosition(new Position(afterPosition.lineNumber, afterPosition.column + 1));
		const viewPosition = this._context.viewModel.coordinatesConverter.convertModelPositionToViewPosition(afterPosition, zone.afterColumnAffinity, true);
		const isVisible = zone.showInHiddenAreas || this._context.viewModel.coordinatesConverter.modelPositionIsVisible(beforePosition);
		return { afterViewLineNumber: viewPosition.lineNumber, heightInPixels: isVisible ? heightInPixels : 0, minWidthInPixels, isInHiddenArea: !isVisible };
	}

	private safeInvoke(zone: IViewZone, callback: ((value: number) => void) | undefined, value: number): void {
		if (!callback) return;
		try {
			callback.call(zone, value);
		} catch (error) {
			onUnexpectedError(error);
		}
	}
}
