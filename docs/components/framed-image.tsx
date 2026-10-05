import type { ComponentProps } from 'react';

import defaultMdxComponents from 'fumadocs-ui/mdx';

const DefaultImage = defaultMdxComponents.img;

/**
 * Fumadocs' Markdown image with a hairline border: screenshots share the page's background, and
 * the border keeps their edges visible.
 */
export function FramedImage({ className, ...props }: ComponentProps<typeof DefaultImage>) {
  return <DefaultImage className={[className, 'border border-fd-border'].join(' ')} {...props} />;
}
