import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';

export const AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID = 'workbench.editor.aiCustomizationManagement';
export const AI_CUSTOMIZATION_MANAGEMENT_EDITOR_INPUT_ID = 'workbench.input.aiCustomizationManagement';

export const CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_EDITOR = new RawContextKey<boolean>('aiCustomizationManagementEditorFocused', false);
