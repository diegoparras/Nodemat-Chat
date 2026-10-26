/**
 * ============================================================================
 * CHATGPT ACCOUNT BRIDGE (EXPERIMENTAL)
 * ============================================================================
 *
 * Permite usar una cuenta de ChatGPT (la suscripción, no una API key) con el
 * mismo mecanismo que usa Codex CLI / OpenClaw: OAuth con PKCE contra
 * auth.openai.com y luego el endpoint https://chatgpt.com/backend-api/codex.
 *
 * Constantes tomadas del código fuente de openai/codex (codex-rs/login y
 * codex-rs/model-provider-info). Si OpenAI las cambia, esto deja de funcionar.
 *
 * ⚠️ No es una API pública documentada. El uso consume los límites de tu plan
 *    de ChatGPT y OpenAI puede cambiarlo o restringirlo en cualquier momento.
 *
 * DISEÑO: el servidor NO guarda tokens. El navegador los guarda (como las API
 * keys) y los envía en cada llamada; esta función solo existe porque
 * auth.openai.com y chatgpt.com no permiten CORS desde otros dominios.
 *
 * Rutas (todas POST, cuerpo JSON):
 *   ?action=token      { code, code_verifier, redirect_uri }  -> tokens + cuenta
 *   ?action=refresh    { refresh_token }                        -> tokens + cuenta
 *   ?action=models     { access_token, account_id }             -> { models: [] }
 *   ?action=responses  { access_token, account_id, body }       -> stream SSE
 */

export interface ChatGPTEnv {
    NODEMAT_PROXY_TOKEN?: string;
    CHATGPT_ORIGINATOR?: string;
    CHATGPT_CLIENT_VERSION?: string;
}

export const CHATGPT_OAUTH = {
    issuer: 'https://auth.openai.com',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    redirectUri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access'
};
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/**
 * Versión de Codex CLI que declaramos al pedir la lista de modelos (codex-rs/codex-api,
 * `client_version`). Actualizar cuando salga una versión nueva de Codex, o definir
 * CHATGPT_CLIENT_VERSION en el entorno. Última revisada: rust-v0.164.0 (2026-10-23).
 */
export const CODEX_CLIENT_VERSION = '0.164.0';

/** Sólo aceptamos "N.N.N" (se arma en la URL: nada de texto libre). */
export const isValidClientVersion = (v: unknown): v is string =>
    typeof v === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(v);

/**
 * Codex sólo muestra en su selector los modelos con `visibility: "list"`, ordenados por
 * `priority`; los "hide" son internos (p. ej. codex-auto-review). Hacemos lo mismo.
 */
export function pickVisibleModels(list: any[]): string[] {
    const slug = (m: any) => m?.slug || m?.id || m?.name;
    const listed = list
        .filter(m => slug(m) && (m.visibility === undefined || m.visibility === 'list'))
        .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    return [...new Set(listed.map(slug))];
}

const json = (status: number, body: any) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

function isCrossSite(request: Request): boolean {
    const site = request.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return true;
    const origin = request.headers.get('origin');
    if (origin) {
        const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || new URL(request.url).host;
        try { if (new URL(origin).host !== host) return true; } catch { return true; }
    }
    return false;
}

/** Decodifica (sin verificar firma) los claims del id_token / access_token. */
function decodeJwt(token?: string): any {
    if (!token) return {};
    try {
        const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = payload + '='.repeat((4 - payload.length % 4) % 4);
        return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch {
        return {};
    }
}

function accountFromTokens(tokens: any) {
    const id = decodeJwt(tokens.id_token);
    const access = decodeJwt(tokens.access_token);
    const auth = id['https://api.openai.com/auth'] || access['https://api.openai.com/auth'] || {};
    return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        id_token: tokens.id_token,
        expires_at: access.exp ? access.exp * 1000 : Date.now() + (tokens.expires_in || 3600) * 1000,
        account_id: auth.chatgpt_account_id || null,
        plan: auth.chatgpt_plan_type || null,
        email: id.email || id['https://api.openai.com/profile']?.email || access['https://api.openai.com/profile']?.email || null
    };
}

async function tokenRequest(body: string, contentType: string) {
    const res = await fetch(`${CHATGPT_OAUTH.issuer}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, Accept: 'application/json' },
        body
    });
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
    if (!res.ok) {
        const msg = data.error_description || data.error?.message || data.error || `HTTP ${res.status}`;
        return json(res.status === 400 || res.status === 401 ? 401 : 502, { error: `OpenAI rechazó el token: ${msg}` });
    }
    return json(200, accountFromTokens(data));
}

function codexHeaders(env: ChatGPTEnv, accessToken: string, accountId?: string, sessionId?: string) {
    const h: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        originator: env.CHATGPT_ORIGINATOR || 'codex_cli_rs',
        'User-Agent': `nodemat-chat/1.1 (${env.CHATGPT_ORIGINATOR || 'codex_cli_rs'})`
    };
    if (accountId) h['ChatGPT-Account-ID'] = accountId;
    if (sessionId) h['session-id'] = sessionId;
    return h;
}

export async function handleChatGPT(request: Request, env: ChatGPTEnv): Promise<Response> {
    if (request.method !== 'POST') return json(405, { error: 'Usa POST' });
    if (isCrossSite(request)) return json(403, { error: 'Sólo se acepta desde la propia app.' });
    if (env.NODEMAT_PROXY_TOKEN && request.headers.get('x-nodemat-proxy-token') !== env.NODEMAT_PROXY_TOKEN) {
        return json(401, { error: 'Token del proxy inválido o ausente: este servidor exige NODEMAT_PROXY_TOKEN. Cárgalo en Ajustes → Servidores MCP → "Token del proxy".' });
    }

    const action = new URL(request.url).searchParams.get('action');
    let payload: any;
    try { payload = await request.json(); } catch { return json(400, { error: 'Cuerpo JSON inválido' }); }

    switch (action) {
        case 'token': {
            const { code, code_verifier } = payload;
            if (!code || !code_verifier) return json(400, { error: 'Faltan code / code_verifier' });
            const form = new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: CHATGPT_OAUTH.clientId,
                code,
                redirect_uri: payload.redirect_uri || CHATGPT_OAUTH.redirectUri,
                code_verifier
            });
            return tokenRequest(form.toString(), 'application/x-www-form-urlencoded');
        }

        case 'refresh': {
            if (!payload.refresh_token) return json(400, { error: 'Falta refresh_token' });
            // Codex usa JSON para el refresh de ChatGPT (codex-rs/login/src/oauth/client.rs)
            return tokenRequest(JSON.stringify({
                client_id: CHATGPT_OAUTH.clientId,
                grant_type: 'refresh_token',
                refresh_token: payload.refresh_token
            }), 'application/json');
        }

        case 'models': {
            if (!payload.access_token) return json(400, { error: 'Falta access_token' });
            // El backend sólo devuelve los modelos compatibles con la versión de Codex que
            // declara el cliente: con una versión vieja la lista sale casi vacía.
            // Prioridad: la que cargó el usuario en Ajustes > variable de entorno > la de este código
            const version = isValidClientVersion(payload.client_version)
                ? payload.client_version
                : env.CHATGPT_CLIENT_VERSION || CODEX_CLIENT_VERSION;
            const res = await fetch(`${CODEX_BASE_URL}/models?client_version=${encodeURIComponent(version)}`, {
                headers: codexHeaders(env, payload.access_token, payload.account_id)
            }).catch((e) => ({ ok: false, status: 502, text: async () => String(e) } as any));
            if (!res.ok) return json(res.status, { error: `No se pudo listar modelos (${res.status}): ${(await res.text()).slice(0, 300)}` });
            const data = await res.json();
            return json(200, { models: pickVisibleModels(data.models || data.data || []) });
        }

        case 'responses': {
            const { access_token, account_id, body, session_id } = payload;
            if (!access_token || !body) return json(400, { error: 'Faltan access_token / body' });
            let upstream: Response;
            try {
                upstream = await fetch(`${CODEX_BASE_URL}/responses`, {
                    method: 'POST',
                    headers: {
                        ...codexHeaders(env, access_token, account_id, session_id),
                        'Content-Type': 'application/json',
                        Accept: 'text/event-stream'
                    },
                    body: JSON.stringify(body),
                    signal: request.signal
                });
            } catch (e: any) {
                return json(502, { error: `No se pudo contactar chatgpt.com: ${e?.message || e}` });
            }
            if (!upstream.ok) {
                const text = await upstream.text();
                let msg = text.slice(0, 500);
                try { const j = JSON.parse(text); msg = j.detail || j.error?.message || j.message || msg; } catch { /* texto plano */ }
                return json(upstream.status, { error: msg, status: upstream.status });
            }
            return new Response(upstream.body, {
                status: 200,
                headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }
            });
        }

        default:
            return json(400, { error: `Acción desconocida: ${action}` });
    }
}
