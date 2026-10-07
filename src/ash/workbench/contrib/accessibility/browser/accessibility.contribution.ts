import './accessibilityConfiguration.js';
import './accessibleViewActions.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AccessibleViewService } from './accessibleView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorAccessibilityHelpContribution } from './editorAccessibilityHelp.js';
import { AccessibilityStatus } from './accessibilityStatus.js';
import { UnfocusedViewDimmingContribution } from './unfocusedViewDimmingContribution.js';

registerSingleton(IAccessibleViewService, AccessibleViewService, InstantiationType.Delayed);

registerWorkbenchContribution(EditorAccessibilityHelpContribution.ID, WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(EditorAccessibilityHelpContribution));
registerWorkbenchContribution(AccessibilityStatus.ID, WorkbenchPhase.BlockRestore, accessor =>
	accessor.get(IInstantiationService).createInstance(AccessibilityStatus));
registerWorkbenchContribution('workbench.contrib.unfocusedViewDimming', WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(UnfocusedViewDimmingContribution));
