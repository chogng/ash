import { Color } from '../../../../base/common/color.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, type IReader } from '../../../../base/common/observable.js';
import { type IObjectCollectionBufferEntry } from '../../gpu/objectCollectionBuffer.js';
import { type RectangleRenderer, type RectangleRendererEntrySpec } from '../../gpu/rectangleRenderer.js';
import { type ViewGpuContext } from '../../gpu/viewGpuContext.js';
import { type RenderingContext, type RestrictedRenderingContext } from '../../view/renderingContext.js';
import { ViewPart } from '../../view/viewPart.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { editorRuler } from '../../../common/core/editorColorRegistry.js';
import { type IColorTheme } from '../../../../platform/theme/common/colorTheme.js';

/** Renders configured editor rulers into the shared GPU rectangle buffer. */
export class RulersGpu extends ViewPart {
	private readonly shapes: IObjectCollectionBufferEntry<RectangleRendererEntrySpec>[] = [];

	constructor(
		context: ViewContext,
		private readonly gpuContext: ViewGpuContext,
	) {
		super(context);
		this._register(autorun(reader => this.updateEntries(reader)));
		this._register(toDisposable(() => {
			while (this.shapes.length > 0) this.shapes.pop()!.dispose();
		}));
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		const changed = event.hasChanged(EditorOption.rulers) || event.hasChanged(EditorOption.fontInfo);
		if (changed) this.updateEntries(undefined);
		return changed;
	}

	public override onThemeChanged(_event: viewEvents.ViewThemeChangedEvent): boolean {
		this.updateEntries(undefined, _event.theme);
		return true;
	}

	public override prepareRender(_context: RenderingContext): void {
	}

	public render(_context: RestrictedRenderingContext): void {}

	private updateEntries(reader: IReader | undefined, theme: IColorTheme = this._context.theme.value): void {
		const devicePixelRatio = this.gpuContext.devicePixelRatio.read(reader);
		const editorOptions = this._context.configuration.options;
		const rulers = editorOptions.get(EditorOption.rulers);
		const typicalHalfwidthCharacterWidth = editorOptions.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
		for (let index = 0; index < rulers.length; index += 1) {
			const ruler = rulers[index]!;
			const color = ruler.color
				? Color.fromHex(ruler.color)
				: theme.getColor(editorRuler) ?? Color.white;
			const entry: Parameters<RectangleRenderer['register']> = [
				ruler.column * typicalHalfwidthCharacterWidth * devicePixelRatio,
				0,
				Math.max(1, Math.ceil(devicePixelRatio)),
				Number.MAX_SAFE_INTEGER,
				color.rgba.r / 255,
				color.rgba.g / 255,
				color.rgba.b / 255,
				color.rgba.a,
			];
			if (this.shapes[index]) this.shapes[index]!.setRaw(entry);
			else this.shapes.push(this.gpuContext.rectangleRenderer.register(...entry));
		}
		while (this.shapes.length > rulers.length) this.shapes.pop()!.dispose();
	}
}
