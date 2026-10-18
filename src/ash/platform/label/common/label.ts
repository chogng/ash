import type { Event } from '../../../base/common/event.js';
import type { URI } from '../../../base/common/uri.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export const ILabelService = createServiceIdentifier<ILabelService>('labelService');

export interface ResourceLabelFormatter {
	readonly scheme: string;
	readonly authority?: string;
	readonly priority?: boolean;
	readonly formatting: {
		readonly label: string;
		readonly separator: '/' | '\\' | '';
		readonly tildify?: boolean;
		readonly normalizeDriveLetter?: boolean;
	};
}

export interface IUriLabelOptions {
	readonly relative?: boolean;
	readonly noPrefix?: boolean;
	readonly separator?: '/' | '\\';
}

export interface IFormatterChangeEvent {
	readonly scheme: string;
}

/** Window-scoped resource formatting, including execution paths requested without prefixes. */
export interface ILabelService extends IDisposable {
	readonly onDidChangeFormatters: Event<IFormatterChangeEvent>;
	getUriLabel(resource: URI, options?: IUriLabelOptions): string;
	getUriBasenameLabel(resource: URI): string;
	getSeparator(scheme: string, authority?: string): '/' | '\\';
	registerFormatter(formatter: ResourceLabelFormatter): IDisposable;
}
