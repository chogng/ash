import { getRegisteredIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import type { ProjectAppearance } from '../../../../platform/projects/common/projectService.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';

export function resolveProjectAppearance(document: Document, appearance: ProjectAppearance | undefined) {
	return {
		icon: appearance?.icon ? getRegisteredIcon(appearance.icon, document) : undefined,
		color: appearance?.color ? `var(${colorCssVariable(appearance.color)})` : undefined,
	};
}
