import { Schemas } from '../../../base/common/network.js';
import { DataUri } from '../../../base/common/resources.js';
import { ThemeIcon, type ThemeIcon as ThemeIconValue } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { FileKind } from '../../../platform/files/common/files.js';
import type { ILanguageService } from '../languages/language.js';
import { PLAINTEXT_LANGUAGE_ID } from '../languages/modesRegistry.js';
import type { IModelService } from './model.js';

export function getIconClasses(
	modelService: Pick<IModelService, 'getModel'> | undefined,
	languageService: Pick<ILanguageService, 'getLanguageIdByMimeType' | 'guessLanguageIdByFilepathOrFirstLine'>,
	resource: URI | undefined,
	fileKind?: FileKind | 'rootFolder',
	icon?: ThemeIconValue | URI,
): string[] {
	if (ThemeIcon.isThemeIcon(icon)) {
		return [`codicon-${icon.id}`, 'predefined-file-icon'];
	}
	if (icon instanceof URI) {
		return [];
	}

	const isFolder = fileKind === FileKind.Directory || fileKind === 'rootFolder';
	const classes = [fileKind === 'rootFolder' ? 'rootfolder-icon' : isFolder ? 'folder-icon' : 'file-icon'];
	if (!resource) {
		return classes;
	}

	const metadata = resource.scheme === Schemas.data ? DataUri.parseMetaData(resource) : undefined;
	let name: string | undefined;
	if (metadata) {
		name = metadata.get(DataUri.META_DATA_LABEL);
	} else {
		const path = decodeURIComponent(resource.path).replace(/\/+$/u, '');
		const segments = path.split('/').filter(Boolean);
		name = segments.at(-1) ?? resource.authority;
		const parent = segments.at(-2);
		if (parent) {
			classes.push(`${fileIconSelectorEscape(parent.toLowerCase())}-name-dir-icon`);
		}
	}

	if (name) {
		name = fileIconSelectorEscape(name.toLowerCase());
	}
	if (fileKind === 'rootFolder') {
		if (name) classes.push(`${name}-root-name-folder-icon`);
		return classes;
	}
	if (isFolder) {
		if (name) classes.push(`${name}-name-folder-icon`);
		return classes;
	}

	if (name) {
		classes.push(`${name}-name-file-icon`, 'name-file-icon');
		// Limit compound extension work for unusually long URI labels.
		if (name.length <= 255) {
			const segments = name.split('.');
			for (let index = 1; index < segments.length; index++) {
				classes.push(`${segments.slice(index).join('.')}-ext-file-icon`);
			}
		}
		classes.push('ext-file-icon');
	}

	const languageId = metadata
		? languageService.getLanguageIdByMimeType(metadata.get(DataUri.META_DATA_MIME))
		: modelService?.getModel(resource)?.getLanguageId();
	const resolvedLanguageId = languageId && languageId !== PLAINTEXT_LANGUAGE_ID
		? languageId
		: languageService.guessLanguageIdByFilepathOrFirstLine(resource);
	if (resolvedLanguageId) {
		classes.push(`${fileIconSelectorEscape(resolvedLanguageId)}-lang-file-icon`);
	}
	return classes;
}

export function getIconClassesForLanguageId(languageId: string): string[] {
	return ['file-icon', `${fileIconSelectorEscape(languageId)}-lang-file-icon`];
}

export function fileIconSelectorEscape(value: string): string {
	return value.replace(/\s/gu, '/');
}
