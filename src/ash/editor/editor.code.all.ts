// Full client-owned text editing; plain-text hosts can use editor.all without these features.
import './editor.all.js';
import './browser/editorFeatures.js';
import { activateEditorFeatures } from './browser/editorFeatureRegistration.js';

// Product bootstrap installs this module once. Models, history and view lifetimes remain
// owned by the editor; no backend or extension activation is needed to edit text.
activateEditorFeatures();
