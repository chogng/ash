import '../workbench/contrib/skills/browser/skills.contribution.js';
import './contrib/files/browser/files.contribution.js';
import './contrib/changes/browser/changes.contribution.js';
import './contrib/editor/browser/emptyFileEditor.contribution.js';
import './contrib/design/browser/design.contribution.js';
import '../workbench/contrib/codeEditor/browser/codeEditor.contribution.js';
import '../workbench/contrib/mediaPreview/browser/mediaPreview.contribution.js';
import '../workbench/contrib/multiDiffEditor/browser/multiDiffEditor.contribution.js';
import { registerTerminalView } from '../workbench/contrib/terminal/browser/terminal.contribution.js';
import { SessionsViewRegistry } from './common/views.js';

registerTerminalView(SessionsViewRegistry);
