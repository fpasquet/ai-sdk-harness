// @ts-check
import { sandboxClientLayers } from '@repo/eslint-config/boundaries';
import nodeConfig from '@repo/eslint-config/node';

export default [...nodeConfig(import.meta.dirname), ...sandboxClientLayers('src')];
