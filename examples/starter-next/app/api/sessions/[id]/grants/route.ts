import type { ApprovalGrant } from 'ai-sdk-harness-approval';

import { withGrants } from 'ai-sdk-harness-approval';

import { errorResponse } from '@/lib/http';
import { sessions } from '@/lib/sessions';

type Context = { params: Promise<{ id: string }> };

const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** A grant read from a request, untrusted input: only what reads as one, and nothing else. */
function grantOf(value: unknown): ApprovalGrant[] {
  const { kind, path, prefix, toolName } = (value ?? {}) as Record<string, unknown>;
  if (kind === 'command' && text(prefix)) return [{ kind, prefix }];
  if (kind === 'edit') return [text(path) ? { kind, path } : { kind }];
  if (kind === 'tool' && text(toolName)) return [{ kind, toolName }];
  return [];
}

const grantsOf = (body: unknown): ApprovalGrant[] => {
  const grants = (body as null | { grants?: unknown })?.grants;
  return Array.isArray(grants) ? grants.flatMap(grantOf) : [];
};

/**
 * "Always allow": keeps the grants with the conversation, in its metadata, for the approval
 * policy to allow the same calls without asking again. It never allows what the policy denies.
 */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const grants = grantsOf(await request.json().catch(() => undefined));
  if (grants.length === 0) return new Response('No grant to keep.', { status: 400 });
  try {
    const session = await sessions().update((await params).id, {
      metadata: (metadata) => ({ ...metadata, grants: withGrants(metadata.grants, grants) }),
    });
    return Response.json(session);
  } catch (error) {
    return errorResponse(error);
  }
}
