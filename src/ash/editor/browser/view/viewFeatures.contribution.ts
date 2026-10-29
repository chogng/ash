import { registerTextViewFeature } from './viewFeatures.js';
import { EditorOption } from '../../common/config/editorOptions.js';
import { Minimap } from '../viewParts/minimap/minimap.js';
import { IndentGuidesOverlay } from '../viewParts/indentGuides/indentGuides.js';
import { MinimapTokensColorTracker } from '../../common/viewModel/minimapTokensColorTracker.js';
import { onActivate } from '../editorFeatureRegistration.js';

onActivate(() => registerTextViewFeature({
	id: 'minimap',
	when: source => source.context.configuration.options.get(EditorOption.minimap).enabled,
	install: source => {
		const part = source.registerPart(new Minimap(source.context, source));
		source.host.append(part.getDomNode().domNode);
		source.register(source.onDidChangeTokens(() => { part.onTokensChanged(); part.forceShouldRender(); }));
		source.register(MinimapTokensColorTracker.getInstance().onDidChange(source.requestRender));
	},
}));
onActivate(() => registerTextViewFeature({
	id: 'indentGuides',
	install: source => source.registerContentOverlay(new IndentGuidesOverlay(source.context, {
		viewModel: source.viewModel, host: source.contentHost,
		readVisualProjection: source.readVisualProjection, readTextLeft: source.readTextLeft, textMeasurer: source.textMeasurer,
	})),
}));
