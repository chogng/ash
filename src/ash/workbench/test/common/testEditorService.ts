import { Event } from '../../../base/common/event.js';
import type { IEditorService } from '../../services/editor/common/editorService.js';

/** Empty editor defaults for tests without dirty documents or save participants. */
export const emptyEditorServiceState = Object.freeze({
	onDidActiveEditorChange: Event.None,
	onDidVisibleEditorsChange: Event.None,
	activeEditor: undefined,
	activeEditorPane: undefined,
	visibleEditors: Object.freeze([]),
	visibleEditorPanes: Object.freeze([]),
	save: async () => ({ success: true, editors: [] }),
	saveAll: async () => ({ success: true, editors: [] }),
}) satisfies Pick<IEditorService, 'onDidActiveEditorChange' | 'onDidVisibleEditorsChange' | 'activeEditor' | 'activeEditorPane' | 'visibleEditors' | 'visibleEditorPanes' | 'save' | 'saveAll'>;
