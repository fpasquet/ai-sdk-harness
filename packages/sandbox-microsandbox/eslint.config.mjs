// @ts-check
import { sandboxClientLayers } from '@repo/eslint-config/boundaries';
import nodeConfig from '@repo/eslint-config/node';

export default [
  ...nodeConfig(import.meta.dirname),
  // Only transport/ reaches the sandboxes, through the microsandbox SDK.
  ...sandboxClientLayers('src', [], { sdk: 'microsandbox' }),
];
