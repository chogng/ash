import type { Event } from "../../../base/common/event.js";
import type { URI } from "../../../base/common/uri.js";
import {
	createServiceIdentifier,
} from "../../instantiation/common/instantiation.js";

/**
 * Window-scoped resource icon theme used by file trees and editor labels.
 *
 * Implementations resolve resource metadata and render only the icon artwork;
 * consumers remain responsible for label structure and interaction affordances.
 */
export interface IFileIconThemeService {
	readonly onDidFileIconThemeChange: Event<void>;

	renderFileIcon(resource: URI, container: HTMLElement): void;
}

export const IFileIconThemeService =
	createServiceIdentifier<IFileIconThemeService>("fileIconThemeService");
