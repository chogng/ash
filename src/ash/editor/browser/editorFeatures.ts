import './view/viewFeatures.contribution.js';
import './services/services.contribution.js';
import './services/contribution.js';
import { createTextModelFeatures } from '../common/model/modelFeatures.js';
import { registerTextModelFeatures } from '../common/model/textModelFeatures.js';
import '../editor.contrib.js';
import '../contrib/placeholderText/browser/placeholderText.contribution.js';
import { onActivate } from './editorFeatureRegistration.js';

onActivate(() => registerTextModelFeatures(createTextModelFeatures));
export { getEditorFeatures } from './editorFeatureRegistration.js';
