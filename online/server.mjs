/**
 * The token service as a small Node server (no packages to install).
 *
 *   ABLY_API_KEY=appId.keyId:secret node online/server.mjs
 *
 * Environment:
 *   ABLY_API_KEY      required. From the Ably dashboard (online/README.md).
 *   PORT              default 8787
 *   ALLOWED_ORIGINS   the browser edition's origins, comma separated ("https://play.example.com")
 *   ALLOW_LOOPBACK    "false" to refuse pages served from a player's own machine (the desktop app is one)
 *   TRUST_PROXY       "true" behind a proxy that sets X-Forwarded-For: the limit is then per player, not per proxy
 *
 * It speaks plain HTTP: put it behind something that speaks HTTPS (the game
 * will not send to an http:// address that is not this machine).
 */
import http from 'node:http';
import { createAuth } from './auth.js';

const key = process.env.ABLY_API_KEY;
if (!key) { console.error('ABLY_API_KEY is not set. See online/README.md.'); process.exit(1); }

const auth = createAuth({
    key,
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    allowLoopback: process.env.ALLOW_LOOPBACK !== 'false',
});
const trustProxy = process.env.TRUST_PROXY === 'true';

const server = http.createServer(async (req, res) => {
    try {
        const chunks = [];
        let size = 0;
        for await (const c of req) { size += c.length; if (size > 4096) { res.writeHead(413).end(); return; } chunks.push(c); }
        let body = null;
        if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; } }
        const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
        const r = await auth.respond({
            method: req.method, path: new URL(req.url, 'http://x').pathname, origin: req.headers.origin ?? '', body,
            ip: forwarded || req.socket.remoteAddress || '',
        });
        res.writeHead(r.status, r.body === null ? r.headers : { ...r.headers, 'Content-Type': 'application/json' });
        res.end(r.body === null ? undefined : JSON.stringify(r.body));
    } catch {
        res.writeHead(500).end();
    }
});

const port = Number(process.env.PORT) || 8787;
server.listen(port, () => console.log(`Wonder World token service on http://localhost:${port} (Ably key ${auth.keyName})`));
