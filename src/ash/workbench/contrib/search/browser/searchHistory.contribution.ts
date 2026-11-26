import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISearchHistoryService, SearchHistoryService } from '../common/searchHistoryService.js';

registerSingleton(ISearchHistoryService, SearchHistoryService, InstantiationType.Delayed);
