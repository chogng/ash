// Full client-owned text editing; plain-text hosts can use editor.all without these features.
import './editor.all.js';
import { getEditorFeatures } from './browser/editorFeatures.js';
import { EditorExtensionsRegistry } from './browser/editorExtensions.js';

// Product bootstrap installs this module once. Models, history and view lifetimes remain
// owned by the editor; no backend or extension activation is needed to edit text.
EditorExtensionsRegistry.registerEditorFeatures(getEditorFeatures());
