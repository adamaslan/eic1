import { createRelayHttpHandler } from '../../../packages/features/src/relay-http';
import { createSupabaseRelayStore } from '../../../packages/features/src/supabase-relay-store';

declare const Deno: { env: { get(key: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };
// Supabase supplies these only inside the Edge runtime. No admin key enters a
// browser bundle, deployment artifact or log. No additional user auth system.
const projectUrl = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!projectUrl || !serviceKey) throw new Error('Server configuration unavailable');
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
    if (result.error || !config || config.enabled !== true || !Array.isArray(config.keys) || !Array.isArray(config.origins)) return new Response(JSON.stringify({ error: 'Encrypted relay is disabled.' }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    return await createRelayHttpHandler(createSupabaseRelayStore({ rpc }), {
      enabled: true, keys: config.keys, origins: config.origins,
      maxPublishesPerWindow: 10, windowMs: 60000, now: () => new Date(),
    })(request);
  } catch {
    return new Response(JSON.stringify({ error: 'Encrypted relay is unavailable.' }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
});
