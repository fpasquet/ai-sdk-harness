/**
 * Cloudflare Pages middleware: the project stays reachable at its pages.dev
 * URL, which redirects to the custom domain, path and query kept. Preview
 * deployments (`<hash>.ai-sdk-harness.pages.dev`) are left as they are.
 */
const PAGES_DEV_HOSTNAME = 'ai-sdk-harness.pages.dev';
const CUSTOM_HOSTNAME = 'ai-sdk-harness.suitebase.dev';

export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);

  if (url.hostname === PAGES_DEV_HOSTNAME) {
    url.hostname = CUSTOM_HOSTNAME;
    return Response.redirect(url.toString(), 301);
  }

  return context.next();
};
