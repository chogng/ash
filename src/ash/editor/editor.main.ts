// Plain-text Stanza entrypoint with standalone host controls. Optional editor behavior is provider-owned.
import "./editor.all.js";
import './standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js';
import './standalone/browser/inspectTokens/inspectTokens.js';
import './standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
import './standalone/browser/quickAccess/standaloneCommandsQuickAccess.js';
import './standalone/browser/toggleHighContrast/toggleHighContrast.js';

export * from "./editor.api.js";
