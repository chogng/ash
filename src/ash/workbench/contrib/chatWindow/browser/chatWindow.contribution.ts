import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IChatWindowService } from './chatWindow.js';
import { ChatWindowService } from './chatWindowService.js';

registerSingleton(IChatWindowService, ChatWindowService, InstantiationType.Delayed);
