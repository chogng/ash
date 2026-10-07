import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { IRemoteService } from './services.js';

export const IMainProcessService = createDecorator<IMainProcessService>('mainProcessService');
export interface IMainProcessService extends IRemoteService { }
