/**
 * ============================================================================
 * CHATGPT AUTH (EXPERIMENTAL) - Login con cuenta de ChatGPT
 * ============================================================================
 *
 * Mismo flujo OAuth + PKCE que Codex CLI (y OpenClaw). Como una web no puede
 * escuchar en http://localhost:1455 (la única redirección registrada para ese
 * cliente OAuth), el flujo es:
 *
 *   1. Nodemat genera PKCE + state y abre la página de login de OpenAI.
 *   2. Tras iniciar sesión, OpenAI redirige a http://localhost:1455/auth/callback?code=...
 *      Esa página NO carga (no hay nada escuchando): es normal.
 *   3. El usuario copia la URL de la barra de direcciones y la pega en Nodemat.
 *   4. /api/chatgpt intercambia el código por tokens (auth.openai.com no admite CORS).
 *
 * Alternativa: importar el ~/.codex/auth.json de una sesión de Codex CLI.
 *
 * Los tokens se guardan en el navegador, igual que las API keys.
 */

import { AppSettings } from '../types';
import { chatgptBridge } from './bridge';

const OAUTH = {
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    redirectUri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access'
};

const PKCE_STORAGE_KEY = 'nodemat_chatgpt_pkce';

export const CHATGPT_FALLBACK_MODELS = ['gpt-5', 'gpt-5-codex'];

export interface ChatGPTAccount {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    expires_at: number;
    account_id: string | null;
    plan: string | null;
    email: string | null;
}

// ----------------------------------------------------------------------------
// PKCE
// ----------------------------------------------------------------------------

const base64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const randomString = (len = 32) => base64url(crypto.getRandomValues(new Uint8Array(len)));

async function sha256base64url(text: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return base64url(new Uint8Array(digest));
}

/** Paso 1: devuelve la URL de login de OpenAI y guarda verifier/state en sessionStorage. */
export async function startChatGPTLogin(): Promise<string> {
    const verifier = randomString(64);
    const state = randomString(32);
    const challenge = await sha256base64url(verifier);
    sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify({ verifier, state, createdAt: Date.now() }));

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: OAUTH.clientId,
        redirect_uri: OAUTH.redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        scope: OAUTH.scope,
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        originator: 'codex_cli_rs'
    });
    return `${OAUTH.authorizeUrl}?${params.toString()}`;
}

/** Paso 3-4: recibe la URL pegada por el usuario y obtiene los tokens. */
export async function completeChatGPTLogin(pastedUrl: string): Promise<ChatGPTAccount> {
    const saved = sessionStorage.getItem(PKCE_STORAGE_KEY);
    if (!saved) throw new Error('No hay un inicio de sesión en curso. Pulsa "Iniciar sesión con ChatGPT" de nuevo.');
    const { verifier, state, createdAt } = JSON.parse(saved);
    if (Date.now() - createdAt > 15 * 60 * 1000) throw new Error('El inicio de sesión expiró (15 min). Vuelve a empezar.');

    let url: URL;
    try {
        url = new URL(pastedUrl.trim());
    } catch {
        throw new Error('Pega la URL completa que empieza con http://localhost:1455/auth/callback?code=...');
    }
    const error = url.searchParams.get('error');
    if (error) throw new Error(`OpenAI devolvió un error: ${url.searchParams.get('error_description') || error}`);
    if (url.searchParams.get('state') !== state) {
        throw new Error('El "state" no coincide: esa URL no corresponde a este inicio de sesión. Vuelve a empezar.');
    }
    const code = url.searchParams.get('code');
    if (!code) throw new Error('La URL no contiene el parámetro "code".');

    const account = await chatgptBridge<ChatGPTAccount>('token', { code, code_verifier: verifier, redirect_uri: OAUTH.redirectUri });
    sessionStorage.removeItem(PKCE_STORAGE_KEY);
    return account;
}

// ----------------------------------------------------------------------------
// Importar auth.json de Codex CLI
// ----------------------------------------------------------------------------

function decodeJwt(token?: string): any {
    if (!token) return {};
    try {
        const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(decodeURIComponent(escape(atob(payload + '='.repeat((4 - payload.length % 4) % 4)))));
    } catch {
        return {};
    }
}

export function importCodexAuthJson(text: string): ChatGPTAccount {
    let data: any;
    try { data = JSON.parse(text); } catch { throw new Error('No es un JSON válido. Pega el contenido completo de ~/.codex/auth.json'); }
    const t = data.tokens || data;
    if (!t.access_token || !t.refresh_token) {
        throw new Error('El archivo no tiene tokens de ChatGPT (¿Codex está logueado con API key en vez de cuenta?).');
    }
    const id = decodeJwt(t.id_token);
    const access = decodeJwt(t.access_token);
    const auth = id['https://api.openai.com/auth'] || access['https://api.openai.com/auth'] || {};
    return {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        id_token: t.id_token,
        expires_at: access.exp ? access.exp * 1000 : Date.now(),
        account_id: t.account_id || auth.chatgpt_account_id || null,
        plan: auth.chatgpt_plan_type || null,
        email: id.email || null
    };
}

// ----------------------------------------------------------------------------
// Sesión: settings <-> cuenta
// ----------------------------------------------------------------------------

export function accountToSettings(acc: ChatGPTAccount): Partial<AppSettings> {
    return {
        chatgptKey: acc.access_token,
        chatgptRefreshToken: acc.refresh_token,
        chatgptAccountId: acc.account_id || '',
        chatgptExpiresAt: acc.expires_at,
        chatgptEmail: acc.email || '',
        chatgptPlan: acc.plan || ''
    };
}

/**
 * Devuelve un access token válido, renovándolo si vence en menos de 5 minutos.
 * Si renovó, llama a onRefreshed con los ajustes nuevos para persistirlos.
 */
export async function ensureFreshChatGPTToken(
    settings: AppSettings,
    onRefreshed?: (patch: Partial<AppSettings>) => void,
    force = false
): Promise<{ accessToken: string; accountId: string }> {
    if (!settings.chatgptKey) throw new Error('No hay una cuenta de ChatGPT conectada. Ve a Ajustes → ChatGPT.');
    const expiringSoon = !settings.chatgptExpiresAt || settings.chatgptExpiresAt - Date.now() < 5 * 60 * 1000;
    if (!force && !expiringSoon) return { accessToken: settings.chatgptKey, accountId: settings.chatgptAccountId };

    if (!settings.chatgptRefreshToken) throw new Error('La sesión de ChatGPT expiró. Vuelve a iniciar sesión.');
    try {
        const acc = await chatgptBridge<ChatGPTAccount>('refresh', { refresh_token: settings.chatgptRefreshToken });
        // Algunos refresh no devuelven refresh_token nuevo: conservar el anterior
        const patch = accountToSettings({ ...acc, refresh_token: acc.refresh_token || settings.chatgptRefreshToken });
        // Un refresh puede venir sin id_token: conservar los datos de la cuenta
        if (!patch.chatgptAccountId) patch.chatgptAccountId = settings.chatgptAccountId;
        if (!patch.chatgptEmail) patch.chatgptEmail = settings.chatgptEmail;
        if (!patch.chatgptPlan) patch.chatgptPlan = settings.chatgptPlan;
        onRefreshed?.(patch);
        return { accessToken: patch.chatgptKey!, accountId: patch.chatgptAccountId! };
    } catch (e: any) {
        throw new Error(`No se pudo renovar la sesión de ChatGPT: ${e.message}. Vuelve a iniciar sesión.`);
    }
}

/** Une los tres bloques de una versión ("0", "164", "0" -> "0.164.0"); '' si falta alguno. */
export function joinVersion(parts: string[]): string {
    const clean = parts.map(p => (p || '').trim());
    return clean.length === 3 && clean.every(p => /^\d{1,5}$/.test(p)) ? clean.map(p => String(Number(p))).join('.') : '';
}

/** Separa una versión pegada ("rust-v0.164.0", "0.164.0") en sus tres bloques. */
export function splitVersion(text: string): string[] | null {
    const m = (text || '').match(/(\d{1,5})\.(\d{1,5})\.(\d{1,5})/);
    return m ? [m[1], m[2], m[3]] : null;
}

export async function fetchChatGPTModels(accessToken: string, accountId: string, clientVersion?: string): Promise<string[]> {
    try {
        const { models } = await chatgptBridge<{ models: string[] }>('models', {
            access_token: accessToken,
            account_id: accountId,
            ...(clientVersion ? { client_version: clientVersion } : {})
        });
        return models.length ? models : CHATGPT_FALLBACK_MODELS;
    } catch {
        return CHATGPT_FALLBACK_MODELS;
    }
}
