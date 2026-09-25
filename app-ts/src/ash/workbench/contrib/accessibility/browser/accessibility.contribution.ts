import './accessibilityConfiguration.js';
import './accessibleViewActions.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AccessibleViewService } from './accessibleView.js';

registerSingleton(IAccessibleViewService, AccessibleViewService, InstantiationType.Delayed);
