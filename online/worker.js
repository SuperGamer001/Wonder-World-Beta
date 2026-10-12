/**
 * The token service as a Cloudflare Worker (free plan: online/README.md says how).
 *
 * Secrets and settings (never in this file, never in wrangler.toml):
 *   ABLY_API_KEY      a secret:  npx wrangler secret put ABLY_API_KEY
 *   ALLOWED_ORIGINS   a variable: the browser edition's origins, comma separated
 *   ALLOW_LOOPBACK    a variable: "false" to refuse pages served from a player's own machine
 */
import { createAuth } from './auth.js';

let auth = null, madeFor = '';

export default {
    async fetch(request, env) {
        if (!env.ABLY_API_KEY) return new Response('ABLY_API_KEY is not set', { status: 500 });
        const settings = `${env.ABLY_API_KEY}|${env.ALLOWED_ORIGINS ?? ''}|${env.ALLOW_LOOPBACK ?? ''}`;
        if (!auth || madeFor !== settings) {
            auth = createAuth({
                key: env.ABLY_API_KEY,
                allowedOrigins: String(env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
                allowLoopback: env.ALLOW_LOOPBACK !== 'false',
            });
            madeFor = settings;
        }
        // Cloudflare says who is asking; nothing a client sends is taken for it.
        return auth.handle(request, request.headers.get('CF-Connecting-IP') ?? '');
    },
};
