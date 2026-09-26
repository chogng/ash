import ashMarkSvg from '../../media/ash-mark.svg?raw';
import { registerLxicon } from '../../../../base/common/lxiconsUtil.js';

export const ashTitlebarMark = registerLxicon('ash-titlebar-mark', () =>
	ashMarkSvg.replace('<svg ', '<svg class="ash-titlebar-mark" '));
