// Full Stanza entrypoint: all contributions plus the stable programmatic API.
import "./editor.all.js";
import './standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js';
import './standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
import './standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js';
import './standalone/browser/quickAccess/standaloneCommandsQuickAccess.js';
import './standalone/browser/toggleHighContrast/toggleHighContrast.js';

export * from "./editor.api.js";
