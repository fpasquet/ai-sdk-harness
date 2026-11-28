import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import { describe, expect, it } from 'vitest';

import { withTransformations } from './transformations.js';

const rule = (path: string, token: string): HarnessV1RequestTransformation => ({
  match: {
    host: 'github.com',
    path: { exact: path },
    headers: [{ key: { exact: 'Authorization' }, value: { exact: 'Basic placeholder-value' } }],
  },
  transform: { headers: { Authorization: `Basic ${token}` } },
});

describe('the credentials a view holds', () => {
  it('take a rule added again for the same match in place of the one before', () => {
    const held = withTransformations(
      [rule('/acme/api.git/info/refs', 'first'), rule('/acme/api.git/git-upload-pack', 'first')],
      [rule('/acme/api.git/git-upload-pack', 'renewed')],
    );

    expect(held).toEqual([
      rule('/acme/api.git/info/refs', 'first'),
      rule('/acme/api.git/git-upload-pack', 'renewed'),
    ]);
    expect(withTransformations(held, [rule('/acme/web.git/info/refs', 'web')])).toHaveLength(3);
  });
});
