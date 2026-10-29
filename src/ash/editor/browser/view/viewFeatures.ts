import { Emitter, type Event } from '../../../base/common/event.js';
import { markAsSingleton, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { ViewContext } from '../../common/viewModel/viewContext.js';
import type { TextModel } from '../../common/model/textModel.js';
import type { IViewModel, TextMeasurer, EditorScrollPosition } from '../../common/viewModel.js';
import type { SemanticTokenSource } from '../../common/tokens/languageTokens.js';
import type { IColorTheme } from '../../../platform/theme/common/themeService.js';
import type { EditorVisualLineProjection } from '../../common/viewModel/modelLineProjection.js';
import type { EditorViewportLayout } from '../../common/viewLayout/viewLayout.js';
import type { ViewPart } from './viewPart.js';
import type { DynamicViewOverlay } from './dynamicViewOverlay.js';

/** View-scoped ports for trusted optional parts; text, layout and input retain their existing owners. */
export interface TextViewFeatureContext {
	readonly context: ViewContext;
	readonly host: HTMLElement;
	readonly contentHost: HTMLElement;
	readonly model: TextModel;
	readonly viewModel: IViewModel;
	readonly textMeasurer: TextMeasurer;
	readonly semanticTokenSource?: SemanticTokenSource;
	readonly semanticHighlightingEnabled: (theme: IColorTheme) => boolean;
	readonly readLayout: () => EditorViewportLayout;
	readonly readVisualProjection: () => EditorVisualLineProjection;
	readonly readProjectionRevision: () => number;
	readonly readTextLeft: () => number;
	readonly scrollTo: (position: EditorScrollPosition) => void;
	readonly requestRender: () => void;
	readonly onDidChangeTokens: Event<void>;
	readonly register: <T extends IDisposable>(value: T) => T;
	readonly registerPart: <T extends ViewPart>(part: T) => T;
	readonly registerContentOverlay: (overlay: DynamicViewOverlay) => void;
}

export interface TextViewFeature {
	readonly id: string;
	readonly when?: (context: TextViewFeatureContext) => boolean;
	install(context: TextViewFeatureContext): void;
}
const features = new Map<string, TextViewFeature>();
const changed = markAsSingleton(new Emitter<void>());
export const onDidChangeTextViewFeatures = changed.event;
export function hasTextViewFeature(id: string): boolean {
	return features.has(id);
}
export function getTextViewFeatures(): readonly TextViewFeature[] {
	return [...features.values()];
}

/** Registration is leased by the admitted provider and observed by existing views and their layout. */
export function registerTextViewFeature(feature: TextViewFeature): IDisposable {
	if (features.has(feature.id)) throw new Error(`Duplicate text view feature '${feature.id}'`);
	features.set(feature.id, feature);
	changed.fire();
	return toDisposable(() => {
		if (features.get(feature.id) === feature) {
			features.delete(feature.id);
			changed.fire();
		}
	});
}
