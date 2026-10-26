import { AppSettings, ChatSession, ThemeOption } from '../types';

/**
 * Variable de entorno del build (Vite expone las que empiezan con VITE_ o REACT_APP_).
 * Acepta el nombre con REACT_APP_ y también busca su equivalente VITE_.
 */
export const getEnv = (key: string, defaultVal: string = ''): string => {
    const env: Record<string, string | undefined> = (import.meta as any).env || {};
    return env[key] || (key.startsWith('REACT_APP_') ? env[key.replace('REACT_APP_', 'VITE_')] : undefined) || defaultVal;
};

// --- Themes Configuration ---
export const THEMES: Record<ThemeOption, { primary: string, primaryHover: string, primaryLight: string, name: string }> = {
    ocean: { primary: '#818cf8', primaryHover: '#6366f1', primaryLight: '#e0e7ff', name: 'Océano' },
    mint: { primary: '#34d399', primaryHover: '#10b981', primaryLight: '#d1fae5', name: 'Menta' },
    lavender: { primary: '#a78bfa', primaryHover: '#8b5cf6', primaryLight: '#ede9fe', name: 'Lavanda' },
    coral: { primary: '#fb7185', primaryHover: '#f43f5e', primaryLight: '#ffe4e6', name: 'Coral' },
    amber: { primary: '#fbbf24', primaryHover: '#f59e0b', primaryLight: '#fef3c7', name: 'Ámbar' },
    rose: { primary: '#f472b6', primaryHover: '#ec4899', primaryLight: '#fce7f3', name: 'Rosa' },
    teal: { primary: '#2dd4bf', primaryHover: '#14b8a6', primaryLight: '#ccfbf1', name: 'Turquesa' },
    slate: { primary: '#64748b', primaryHover: '#475569', primaryLight: '#f1f5f9', name: 'Pizarra' },
};

// --- Constants & Defaults ---
export const DEFAULT_MCP_REGISTRY = getEnv('REACT_APP_MCP_REGISTRY_URL', 'https://mcpplaygroundonline.com/mcp-registry');

export const DEFAULT_SETTINGS: AppSettings = {
    theme: 'ocean',
    darkMode: false,

    groqKey: getEnv('REACT_APP_GROQ_API_KEY', ''),
    groqModel: 'llama-3.3-70b-versatile',
    groqConnected: !!getEnv('REACT_APP_GROQ_API_KEY', ''),
    groqModelsList: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'],

    openRouterKey: getEnv('REACT_APP_OPENROUTER_API_KEY', ''),
    openRouterModel: 'openai/gpt-4o-mini',
    openRouterConnected: !!getEnv('REACT_APP_OPENROUTER_API_KEY', ''),
    openRouterModelsList: ['openai/gpt-4o-mini', 'openai/gpt-4o', 'google/gemini-2.5-flash'],

    openaiKey: getEnv('REACT_APP_OPENAI_API_KEY', ''),
    openaiModel: 'gpt-4o-mini',
    openaiConnected: !!getEnv('REACT_APP_OPENAI_API_KEY', ''),
    openaiModelsList: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],

    anthropicKey: getEnv('REACT_APP_ANTHROPIC_API_KEY', ''),
    anthropicModel: 'claude-opus-5-5',
    anthropicConnected: !!getEnv('REACT_APP_ANTHROPIC_API_KEY', ''),
    anthropicModelsList: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],

    cerebrasKey: getEnv('REACT_APP_CEREBRAS_API_KEY', ''),
    cerebrasModel: 'llama3.1-8b',
    cerebrasConnected: !!getEnv('REACT_APP_CEREBRAS_API_KEY', ''),
    cerebrasModelsList: ['llama3.1-8b', 'llama-3.3-70b'],

    geminiKey: getEnv('REACT_APP_GEMINI_API_KEY', ''),
    geminiModel: 'gemini-2.5-flash',
    geminiConnected: !!getEnv('REACT_APP_GEMINI_API_KEY', ''),
    geminiModelsList: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],

    xaiKey: getEnv('REACT_APP_XAI_API_KEY', ''),
    xaiModel: 'grok-3-mini',
    xaiConnected: !!getEnv('REACT_APP_XAI_API_KEY', ''),
    xaiModelsList: ['grok-3-mini', 'grok-3', 'grok-4'],

    // Custom 1 - Configurable via env vars or UI
    custom1Name: getEnv('REACT_APP_CUSTOM1_NAME', 'Personalizado 1'),
    custom1Key: getEnv('REACT_APP_CUSTOM1_API_KEY', ''),
    custom1Url: getEnv('REACT_APP_CUSTOM1_API_URL', 'https://api.openai.com/v1'),
    custom1Model: getEnv('REACT_APP_CUSTOM1_MODEL', ''),
    custom1Connected: !!getEnv('REACT_APP_CUSTOM1_API_KEY', ''),
    custom1ModelsList: [],

    // Custom 2 - Configurable via env vars or UI
    custom2Name: getEnv('REACT_APP_CUSTOM2_NAME', 'Personalizado 2'),
    custom2Key: getEnv('REACT_APP_CUSTOM2_API_KEY', ''),
    custom2Url: getEnv('REACT_APP_CUSTOM2_API_URL', 'https://api.openai.com/v1'),
    custom2Model: getEnv('REACT_APP_CUSTOM2_MODEL', ''),
    custom2Connected: !!getEnv('REACT_APP_CUSTOM2_API_KEY', ''),
    custom2ModelsList: [],

    // Cuenta de ChatGPT (experimental)
    chatgptKey: '',
    chatgptRefreshToken: '',
    chatgptAccountId: '',
    chatgptExpiresAt: 0,
    chatgptEmail: '',
    chatgptPlan: '',
    chatgptModel: 'gpt-5',
    chatgptConnected: false,
    chatgptModelsList: ['gpt-5', 'gpt-5-codex'],
    chatgptClientVersion: '0.164.0',

    proxyToken: '',

    // System Prompt
    systemPrompt: '',

    activeProvider: 'groq',

    mcpRegistryUrl: DEFAULT_MCP_REGISTRY,
    mcpServers: [],

    incognitoMode: false
};

export const INITIAL_SESSION: ChatSession = {
    id: 'init',
    title: 'Nuevo Chat',
    messages: [],
    createdAt: Date.now(),
};



/**
 * Pantalla de acceso OPCIONAL: sólo aparece si se definió VITE_ADMIN_PASSWORD.
 * Ojo: se valida en el navegador y el valor queda en el bundle, así que sólo
 * evita que alguien use la app por accidente; no protege nada de verdad.
 */
export const LOGIN_USER = getEnv('REACT_APP_ADMIN_USER', '');
export const LOGIN_PASSWORD = getEnv('REACT_APP_ADMIN_PASSWORD', '');
export const LOGIN_REQUIRED = !!LOGIN_PASSWORD;
