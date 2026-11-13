import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IChatWindowService } from './chatWindow.js';
import { ChatWindowService } from './chatWindowService.js';
import { registerChatWindowEditor } from './chatWindowParts.js';
import { registerChatWindowLayoutActions } from './chatWindowLayoutActions.js';

registerChatWindowEditor();
registerChatWindowLayoutActions();
registerSingleton(IChatWindowService, ChatWindowService, InstantiationType.Delayed);
