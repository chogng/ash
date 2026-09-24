import type { Event } from "../../../base/common/event.js";
import type { URI } from "../../../base/common/uri.js";
import { createDecorator } from "../../../platform/instantiation/common/instantiation.js";
import type { ITextBufferFactory, ITextModel, ITextModelCreationOptions } from '../model.js';
import type { ILanguageSelection } from '../languages/language.js';
import type { TextModelEditSource } from '../textModelEditSource.js';

export const IModelService = createDecorator<IModelService>("modelService");

export interface IModelService {
	readonly _serviceBrand: undefined;
	createModel(value: string | ITextBufferFactory, languageSelection: ILanguageSelection | null, resource?: URI, isForSimpleWidget?: boolean): ITextModel;
	updateModel(model: ITextModel, value: string | ITextBufferFactory, reason?: TextModelEditSource): void;
	destroyModel(resource: URI): void;
	getModel(resource: URI): ITextModel | null;
	getModels(): ITextModel[];
	getCreationOptions(language: string, resource: URI, isForSimpleWidget: boolean): ITextModelCreationOptions;
	readonly onModelAdded: Event<ITextModel>;
	readonly onModelRemoved: Event<ITextModel>;
	readonly onModelLanguageChanged: Event<{ readonly model: ITextModel; readonly oldLanguageId: string }>;
}
