import { createRelayHttpHandler } from '../../../packages/features/src/relay-http';
import { createSupabaseRelayMembership, createSupabaseRelayStore } from '../../../packages/features/src/supabase-relay-store';
import { verifyTurnstileToken } from '../../../packages/features/src/relay-enroll';
import { DirectoryService, admitDirectoryPrincipal } from '../../../packages/features/src/discover-directory';
import { createSupabaseDirectoryStore } from '../../../packages/features/src/supabase-directory-store';

declare const Deno: { env: { get(key: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };
// Supabase supplies these only inside the Edge runtime. No admin key enters a
// browser bundle, deployment artifact or log. No additional user auth system.
const projectUrl = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!projectUrl || !serviceKey) throw new Error('Server configuration unavailable');
// Self-enrollment is OFF unless the server-only Turnstile secret is set. No secret, no open door.
const turnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY');
const rpc = async (name: string, args: Record<string, unknown>) => {
  const response = await fetch(`${projectUrl}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  if (!response.ok) return { data: null, error: true };
  // PostgREST VOID RPCs succeed with 204 and no JSON body.
  if (response.status === 204) return { data: null, error: null };
  const text = await response.text();
  return { data: text ? JSON.parse(text) : null, error: null };
};
Deno.serve(async request => {
  try {
    const result = await rpc('eic_relay_config', {});
    const config = result.data;
    if (result.error || !config || config.enabled !== true || !Array.isArray(config.origins)) return new Response(JSON.stringify({ error: 'Encrypted relay is disabled.' }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    const membership = createSupabaseRelayMembership({ rpc });
    return await createRelayHttpHandler(createSupabaseRelayStore({ rpc }), {
      // v2: membership = enrolled members plus config.public_keys (manual override), both
      // checked inside eic_relay_is_member. Requires hosted-relay-v2-members.sql applied.
      enabled: true, membership, origins: config.origins,
      maxPublishesPerWindow: 10, windowMs: 60000, now: () => new Date(),
      // Discover: a signed directory action. Admission binds each principal to a member key.
      directory: new DirectoryService(createSupabaseDirectoryStore({ rpc }), (principal, pubkey) => admitDirectoryPrincipal(membership.isMember, principal, pubkey), () => Date.now()),
      selfEnroll: turnstileSecret ? {
        verifyTurnstile: (token: string) => verifyTurnstileToken(turnstileSecret, token),
        claimDailySlot: async () => {
          const result = await rpc('eic_relay_claim_self_enroll', { p_limit: config.self_enroll_per_day ?? 0 });
          return result.error === null && result.data === true;
        },
      } : undefined,
    })(request);
  } catch {
    return new Response(JSON.stringify({ error: 'Encrypted relay is unavailable.' }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
});
