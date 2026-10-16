import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ISnippetsService } from './snippets.js';
import { SnippetsService } from './snippetsService.js';

// The declaration transaction needs its snippet owner before view/completion startup.
registerSingleton(ISnippetsService, SnippetsService, InstantiationType.Eager);
