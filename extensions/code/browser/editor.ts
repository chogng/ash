import './viewFeatures.js';
import './services.contribution.js';
import './markerDecorations.contribution.js';
import './modelFeatures.js';
import './features.js';
import manifest from '../package.json' with { type: 'json' };
import { placeholderContribution } from './contrib/placeholderText/placeholderText.contribution.js';
import { registerEditorContribution } from './registration.js';

export const packageId = `${manifest.publisher}.${manifest.name}`;
export const packageVersion = manifest.version;
registerEditorContribution(placeholderContribution);
export { getEditorFeatures } from './registration.js';
