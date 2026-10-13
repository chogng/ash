import './media/quickInput.css';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { QuickInputService } from '../../../../platform/quickinput/browser/quickInputService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';

registerSingleton(IQuickInputService, QuickInputService, InstantiationType.Delayed);
