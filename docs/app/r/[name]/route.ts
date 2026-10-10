import { REGISTRY_COMPONENTS, registryIndex, registryItem } from '@/lib/registry';

export const dynamic = 'force-static';

/** One file per component, and the index: written once by the static export. */
export const generateStaticParams = () => [
  { name: 'registry.json' },
  ...REGISTRY_COMPONENTS.map(({ name }) => ({ name: `${name}.json` })),
];

/** The shadcn registry of the site: `npx shadcn@latest add <site>/r/tool-approval.json`. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await params;
  if (name === 'registry.json') return Response.json(registryIndex());
  const component = REGISTRY_COMPONENTS.find((candidate) => `${candidate.name}.json` === name);
  if (component === undefined) return new Response('Not found', { status: 404 });
  return Response.json(await registryItem(component));
}
