/**
 * ============================================================================
 * LLM SERVICE - Language Model API Orchestrator
 * ============================================================================
 *
 * Este servicio orquesta todas las comunicaciones con los proveedores de LLM.
 * Proporciona una interfaz unificada para:
 *
 * - Enviar mensajes a múltiples proveedores (Groq, OpenRouter, OpenAI, etc.)
 * - Ejecutar herramientas MCP (Model Context Protocol) -> ver mcpClient.ts
 * - Manejar el ciclo de vida de una conversación con tool calling
 *
 * ARQUITECTURA:
 * - Todas las llamadas API se hacen directamente desde el navegador
 * - No hay backend intermedio (Zero-Knowledge Architecture)
 * - Las API keys se transmiten únicamente al proveedor seleccionado
 *
 * SEGURIDAD:
 * - Las keys NUNCA se loguean ni se almacenan fuera del navegador
 * - CORS puede bloquear algunas APIs (ej: Anthropic), usar fallback models
 * - Las ejecuciones MCP requieren aprobación explícita del usuario
 *   (salvo que el usuario marque el servidor como "auto-aprobar")
 *
 * EDUCATIVO:
 * Este archivo es ideal para aprender cómo funcionan las APIs de LLM:
 * - Estructura de mensajes (roles: system, user, assistant, tool)
 * - Tool calling / Function calling (formato OpenAI vs formato Gemini)
 * - Contenido multimodal (imágenes y PDFs de entrada, imágenes de salida)
 */

import { AppSettings, Message, Provider, MCPTool, MCPServer, Attachment, ToolCall } from "../types";
import { callServerTool, connectServer, getFriendlyMCPError, readSSE, MCPProgress } from "./mcpClient";
import { validateArgs } from "./jsonSchema";
import { imageCredentials, imageGenService, AspectRatio } from "./imageGenService";
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_FALLBACK_MODELS, callAnthropic, fetchAnthropicModels } from "./anthropicProvider";
import { bridgeHeaders, CHATGPT_BRIDGE_PATH } from "./bridge";
import { ensureFreshChatGPTToken } from "./chatgptAuth";

// ============================================================================
// PROVIDER ENDPOINTS
// ============================================================================

/**
 * Endpoints de API para cada proveedor soportado.
 * Cada proveedor tiene dos URLs:
 * - chat: Para enviar mensajes de conversación
 * - models: Para obtener la lista de modelos disponibles
 */
const PROVIDER_ENDPOINTS: Record<Provider, { chat: string; models: string }> = {
    groq: {
        chat: 'https://api.groq.com/openai/v1/chat/completions',
        models: 'https://api.groq.com/openai/v1/models'
    },
    openrouter: {
        chat: 'https://openrouter.ai/api/v1/chat/completions',
        models: 'https://openrouter.ai/api/v1/models'
    },
    openai: {
        chat: 'https://api.openai.com/v1/chat/completions',
        models: 'https://api.openai.com/v1/models'
    },
    cerebras: {
        chat: 'https://api.cerebras.ai/v1/chat/completions',
        models: 'https://api.cerebras.ai/v1/models'
    },
    gemini: {
        // Gemini usa un formato diferente: el modelo va en la URL
        chat: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
        models: 'https://generativelanguage.googleapis.com/v1beta/models'
    },
    xai: {
        chat: 'https://api.x.ai/v1/chat/completions',
        models: 'https://api.x.ai/v1/models'
    },
    // Anthropic tiene su propio formato: ver anthropicProvider.ts
    anthropic: { chat: '', models: '' },
    // Proveedores personalizados - URLs se configuran dinámicamente
    custom1: { chat: '', models: '' },
    custom2: { chat: '', models: '' },
    // Cuenta de ChatGPT: pasa por /api/chatgpt (ver callChatGPT más abajo)
    chatgpt: { chat: '', models: '' }
};

/**
 * Modelos de respaldo cuando la API de /models falla.
 * Útil para UX más rápida y cuando CORS bloquea la petición inicial.
 */
const FALLBACK_MODELS: Partial<Record<Provider, string[]>> = {
    openai: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
    gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    custom1: [],
    custom2: []
};

/** Proveedores que informan tokens en streaming sólo si se pide `stream_options.include_usage` */
const STREAM_USAGE_PROVIDERS: Provider[] = ['openai', 'openrouter', 'xai', 'cerebras'];

/** Proveedores que aceptan PDFs de forma nativa en el chat */
const PDF_NATIVE_PROVIDERS: Provider[] = ['openai', 'openrouter', 'gemini', 'chatgpt', 'anthropic'];

/**
 * Proveedores con visión: a ellos se les reenvían las imágenes que devuelven
 * las herramientas MCP (a los demás, sólo el texto, o la API rechazaría el turno).
 */
const VISION_PROVIDERS: Provider[] = ['openai', 'openrouter', 'gemini', 'chatgpt', 'xai', 'anthropic'];

/** Máximo de rondas LLM <-> herramientas por mensaje del usuario */
const MAX_TOOL_TURNS = 8;

const uid = () => (crypto as any).randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Re-export para compatibilidad con código existente
export { getFriendlyMCPError };

/**
 * Convierte el error de un proveedor en un mensaje que diga QUÉ pasó y qué hacer.
 * Antes todo terminaba en "Verifica tu conexión", aunque el problema fuera el saldo.
 */
export function getFriendlyLLMError(message: string, providerName: string): string {
    const msg = message || 'Error desconocido';
    if (/key limit exceeded|credit limit|insufficient[_ ](credits|quota|balance|funds)|exceeded your current quota|requires more credits|payment required|\b402\b|billing/i.test(msg)) {
        return `💳 Se agotó el saldo o el límite de gasto de tu API key de ${providerName}. No es un problema de conexión.\n\n` +
            `Qué hacer: carga créditos o sube/quita el límite de esa key en el panel del proveedor ` +
            `(en OpenRouter: openrouter.ai/settings/keys → editar la key → "Credit limit"), o usa otro proveedor.\n\nDetalle: ${msg}`;
    }
    if (/\b401\b|invalid[_ ]api[_ ]key|incorrect api key|unauthorized|no auth credentials/i.test(msg)) {
        return `🔑 ${providerName} rechazó la API key (inválida, vencida o revocada). Revísala en Ajustes.\n\nDetalle: ${msg}`;
    }
    if (/\b429\b|rate[_ ]limit|too many requests/i.test(msg)) {
        return `⏳ ${providerName} está limitando la cantidad de pedidos. Espera un momento y vuelve a intentar.\n\nDetalle: ${msg}`;
    }
    if (/Failed to fetch|NetworkError|Load failed|ERR_NETWORK|ECONNRESET/i.test(msg)) {
        return `📡 No se pudo conectar con ${providerName}. Verifica tu conexión a internet.\n\nDetalle: ${msg}`;
    }
    return `Error de ${providerName}: ${msg}`;
}

// ============================================================================
// API CALLS - MODEL FETCHING
// ============================================================================

/**
 * Obtiene la lista de modelos disponibles para un proveedor.
 *
 * EDUCATIVO: Esta función demuestra cómo cada proveedor tiene
 * formatos de respuesta ligeramente diferentes para su API de models.
 */
export const fetchModels = async (provider: Provider, key: string, customUrl?: string): Promise<string[]> => {
    if (provider === 'anthropic') {
        const list = await fetchAnthropicModels(key);
        return list.length ? list : ANTHROPIC_FALLBACK_MODELS;
    }
    try {
        let endpoint = PROVIDER_ENDPOINTS[provider].models;

        // Para proveedores custom, usar la URL proporcionada
        if ((provider === 'custom1' || provider === 'custom2') && customUrl) {
            endpoint = `${customUrl.replace(/\/+$/, '')}/models`;
        }

        if (!endpoint) {
            return FALLBACK_MODELS[provider] || [];
        }

        let headers: Record<string, string> = {};

        // Configuración específica de autenticación por proveedor
        if (provider === 'gemini') {
            // Gemini acepta la key en un header propio (mejor que en la URL: no queda en logs)
            headers = { 'x-goog-api-key': key };
            endpoint += '?pageSize=1000';
        } else {
            headers = { 'Authorization': `Bearer ${key}` };
            if (provider === 'openrouter') {
                // OpenRouter requiere HTTP-Referer para tracking
                headers['HTTP-Referer'] = window.location.origin;
            }
        }

        const response = await fetch(endpoint, { method: 'GET', headers });

        if (!response.ok) {
            // API falló, usar modelos de respaldo
            return FALLBACK_MODELS[provider] || [];
        }

        const data = await response.json();

        // Gemini tiene formato de respuesta diferente
        if (provider === 'gemini') {
            return data.models
                ?.filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
                .map((m: any) => m.name.replace('models/', '')) || FALLBACK_MODELS[provider] || [];
        }

        // Formato estándar OpenAI-compatible (mayoría de proveedores)
        return data.data?.map((m: any) => m.id) || [];
    } catch {
        // Silenciar error y retornar fallback
        return FALLBACK_MODELS[provider] || [];
    }
};

/**
 * Conecta a un servidor MCP y obtiene la lista de herramientas disponibles.
 * (Wrapper de compatibilidad: la lógica real vive en mcpClient.ts)
 */
export const connectToMCP = async (url: string, transport: string, authType: string, token: string): Promise<MCPTool[]> => {
    const res = await connectServer({
        id: `adhoc-${url}`, url, transport: transport as any, authType: authType as any, authToken: token,
        status: 'idle', errorMessage: '', tools: [], enabledTools: []
    });
    return res.tools;
};

// ============================================================================
// TOOLS: del catálogo MCP a "function definitions" para el LLM
// ============================================================================

interface ToolBinding {
    server: MCPServer;
    originalName: string;
    tool: MCPTool;
}

/**
 * Los LLMs exigen nombres de función `^[a-zA-Z0-9_-]{1,64}$` y únicos.
 * Dos servidores MCP pueden exponer la misma herramienta (ej. "search"),
 * así que si hay colisión prefijamos con el nombre del servidor.
 */
const buildToolRegistry = (servers: MCPServer[]) => {
    const bindings: Record<string, ToolBinding> = {};
    const defs: any[] = [];
    const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool';

    servers.forEach((server, idx) => {
        if (server.status !== 'connected') return;
        const prefix = sanitize(server.name || server.serverInfo?.name || `mcp${idx + 1}`).slice(0, 20);

        server.tools
            .filter(t => server.enabledTools.includes(t.name))
            .forEach(tool => {
                let exposed = sanitize(tool.name);
                if (bindings[exposed]) exposed = sanitize(`${prefix}__${tool.name}`);
                let n = 2;
                while (bindings[exposed]) exposed = sanitize(`${prefix}__${tool.name}`).slice(0, 60) + `_${n++}`;

                bindings[exposed] = { server, originalName: tool.name, tool };

                const schema = tool.inputSchema && typeof tool.inputSchema === 'object'
                    ? { ...tool.inputSchema }
                    : { type: 'object', properties: {} };
                if (!schema.type) schema.type = 'object';
                delete schema.$schema;

                defs.push({
                    type: "function",
                    function: {
                        name: exposed,
                        description: (tool.description || tool.title || '').slice(0, 1024),
                        parameters: schema
                    }
                });
            });
    });

    return { bindings, defs };
};

// ============================================================================
// MENSAJES: del historial de la app al formato de la API (estilo OpenAI)
// ============================================================================

/** Quita imágenes base64 embebidas en markdown: reenviarlas como texto costaría miles de tokens. */
const stripDataUrls = (text: string | null) =>
    (text || '').replace(/!\[([^\]]*)\]\(data:[^)]+\)/g, '[imagen: $1]');

/**
 * Construye el `content` de un mensaje de usuario con adjuntos.
 * - Imágenes -> `image_url` (todos los proveedores con visión)
 * - PDF      -> `file` (OpenAI / OpenRouter) o inlineData (Gemini)
 * - Texto    -> se pega inline en el prompt
 */
const buildUserContent = (text: string, attachments: Attachment[] | undefined, provider: Provider) => {
    if (!attachments || attachments.length === 0) return text;

    const parts: any[] = [{ type: "text", text: text || "" }];
    const inline = (name: string, body: string) => { parts[0].text += `\n\n--- Archivo Adjunto: ${name} ---\n${body}\n-------------------`; };
    attachments.forEach(att => {
        if (att.type.startsWith('image/')) {
            parts.push({ type: "image_url", image_url: { url: att.data } });
        } else if (att.type === 'application/pdf') {
            if (PDF_NATIVE_PROVIDERS.includes(provider)) {
                parts.push({ type: "file", file: { filename: att.name, file_data: att.data } });
            } else if (att.extractedText) {
                // Sin PDF nativo: el modelo lee el texto que sacamos con pdf.js
                inline(att.name, att.extractedText);
            } else {
                parts[0].text += `\n\n[Adjunto PDF "${att.name}" omitido: no se pudo extraer su texto y este proveedor no acepta PDFs.]`;
            }
        } else if (att.extractedText) {
            // Word, Excel, PowerPoint, OpenDocument y audio: va el texto extraído / transcripto
            inline(att.name, att.extractedText);
        } else {
            inline(att.name, att.data);
        }
    });
    return parts;
};

// ============================================================================
// HERRAMIENTA INTERNA: GENERAR IMÁGENES
// ============================================================================

/**
 * EDUCATIVO: no todas las herramientas vienen de un servidor MCP. Nodemat le
 * ofrece al modelo una propia, con la misma forma (nombre, descripción y JSON
 * Schema), que llama al generador de imágenes configurado. Así cualquier
 * modelo de chat, aunque no genere imágenes, puede "pedir" una.
 */
export const IMAGE_TOOL_NAME = 'nodemat_generar_imagen';

const imageToolDefinition = (model: string) => ({
    type: 'function',
    function: {
        name: IMAGE_TOOL_NAME,
        description: `Genera o edita imágenes con el modelo ${model}. Úsala cuando el usuario pida una imagen, ilustración, logo, foto o dibujo. ` +
            'El prompt debe ser detallado (sujeto, estilo, composición, luz, colores). Para editar una imagen existente, pasa su referencia nodemat://adjunto/… en "referencias".',
        parameters: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Descripción detallada de la imagen a generar o del cambio a aplicar' },
                formato: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], description: 'Proporción de la imagen (por defecto 1:1)' },
                referencias: { type: 'array', items: { type: 'string' }, description: 'Referencias nodemat://adjunto/… de imágenes a editar o a usar como estilo' }
            },
            required: ['prompt']
        }
    }
});

async function runImageTool(args: any, settings: AppSettings, fileRefs: Map<string, Attachment>, signal?: AbortSignal) {
    const cfg = settings.imageTool!;
    const { apiKey, customUrl } = imageCredentials(settings, cfg.provider);
    if (!apiKey) return { text: `Error: falta la API key de ${cfg.provider} para generar imágenes.`, images: [] as Attachment[], isError: true };
    const references = (Array.isArray(args.referencias) ? args.referencias : [])
        .map((r: string) => fileRefs.get(String(r).split('?')[0])?.data)
        .filter((d: string | undefined): d is string => !!d && d.startsWith('data:image/'));
    const res = await imageGenService.generateImage({
        prompt: String(args.prompt || ''),
        model: cfg.model,
        provider: cfg.provider,
        apiKey,
        customUrl,
        aspectRatio: (['1:1', '16:9', '9:16', '4:3', '3:4'].includes(args.formato) ? args.formato : '1:1') as AspectRatio,
        referenceImages: references,
        signal
    });
    if (res.error || !res.images.length) return { text: `Error generando la imagen: ${res.error || 'sin imágenes'}`, images: [] as Attachment[], isError: true };
    const stamp = Date.now();
    const images: Attachment[] = res.images.map((img, i) => ({
        name: `imagen-${stamp}-${i + 1}.${img.mimeType.split('/')[1] || 'png'}`,
        type: img.mimeType,
        data: img.url
    }));
    return {
        text: `Se generaron ${images.length} imagen(es) con ${cfg.model} y ya se muestran al usuario. ` +
            `Referencias para editarlas después: ${images.map(i => FILE_REF_PREFIX + encodeURIComponent(i.name)).join(', ')}.` +
            (res.revised_prompt ? ` Prompt revisado por el proveedor: ${res.revised_prompt}` : ''),
        images,
        isError: false
    };
}

// ============================================================================
// ARCHIVOS PARA LAS HERRAMIENTAS MCP
// ============================================================================

/**
 * EDUCATIVO: el modelo no puede "pasarle" un archivo a una herramienta (sólo
 * escribe texto JSON). Entonces le damos una referencia corta por archivo
 * subido, `nodemat://adjunto/<nombre>`, y cuando la usa como argumento Nodemat
 * la reemplaza por el contenido real antes de llamar al servidor MCP:
 *   - archivos binarios -> base64 (sin el prefijo data:)
 *   - texto             -> el texto
 *   - `?formato=dataurl` -> data URL completa; `?formato=texto` -> texto extraído
 */
export const FILE_REF_PREFIX = 'nodemat://adjunto/';

export const buildFileRefs = (history: Message[]): Map<string, Attachment> => {
    const refs = new Map<string, Attachment>();
    history.forEach(m => (m.role === 'user' || m.role === 'tool' || m.role === 'model') && (m.attachments || []).forEach(att => {
        let ref = FILE_REF_PREFIX + encodeURIComponent(att.name);
        for (let n = 2; refs.has(ref) && refs.get(ref) !== att; n++) ref = `${FILE_REF_PREFIX}${encodeURIComponent(att.name)}-${n}`;
        refs.set(ref, att);
    }));
    return refs;
};

const fileRefValue = (att: Attachment, format: string | null): string => {
    const isDataUrl = att.data.startsWith('data:');
    if (format === 'texto') return att.extractedText || (isDataUrl ? '' : att.data);
    if (format === 'dataurl') return isDataUrl ? att.data : `data:${att.type || 'text/plain'};base64,${btoa(unescape(encodeURIComponent(att.data)))}`;
    return isDataUrl ? att.data.slice(att.data.indexOf(',') + 1) : att.data;
};

/** Reemplaza (en profundidad) las referencias a adjuntos por su contenido. */
export const resolveFileRefs = (value: any, refs: Map<string, Attachment>): any => {
    if (typeof value === 'string' && value.startsWith(FILE_REF_PREFIX)) {
        const [ref, query] = value.split('?');
        const att = refs.get(ref);
        return att ? fileRefValue(att, new URLSearchParams(query || '').get('formato')) : value;
    }
    if (Array.isArray(value)) return value.map(v => resolveFileRefs(v, refs));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveFileRefs(v, refs)]));
    return value;
};

/**
 * EDUCATIVO: el rol `tool` sólo admite texto en casi todas las APIs. Para que
 * el modelo VEA una imagen devuelta por una herramienta (una captura, un
 * gráfico…), se la mandamos a continuación como un mensaje de usuario.
 */
const toolImagesMessage = (images: Attachment[], provider: Provider) => {
    if (!images.length || !VISION_PROVIDERS.includes(provider)) return null;
    return {
        role: 'user',
        content: [
            { type: 'text', text: `[Imágenes devueltas por las herramientas (${images.length})]` },
            ...images.map(img => ({ type: 'image_url', image_url: { url: img.data } }))
        ]
    };
};

/**
 * Convierte el historial de la app a mensajes de API.
 * Además "repara" historiales inconsistentes: si un assistant pidió tools
 * pero falta alguna respuesta (p. ej. el usuario canceló), agregamos una
 * respuesta sintética, porque todas las APIs rechazan tool_calls huérfanos.
 */
const toApiMessages = (history: Message[], provider: Provider): any[] => {
    const out: any[] = [];

    for (let i = 0; i < history.length; i++) {
        const m = history[i];

        if (m.role === 'user') {
            out.push({ role: 'user', content: buildUserContent(m.content || '', m.attachments, provider) });
        } else if (m.role === 'model' || m.role === 'assistant') {
            const msg: any = { role: 'assistant', content: stripDataUrls(m.content) };
            // Claude necesita sus bloques originales (thinking incluido) en los turnos siguientes
            if (provider === 'anthropic' && m.providerContent?.length) msg.anthropic_content = m.providerContent;
            if (m.toolCalls && m.toolCalls.length > 0) {
                msg.tool_calls = m.toolCalls;
                out.push(msg);

                // Recolectar las respuestas que siguen
                const answered = new Set<string>();
                const toolImages: Attachment[] = [];
                while (history[i + 1]?.role === 'tool') {
                    const t = history[++i];
                    answered.add(t.tool_call_id || '');
                    out.push({ role: 'tool', tool_call_id: t.tool_call_id, name: t.name, content: t.content || '' });
                    toolImages.push(...(t.attachments || []).filter(a => a.type.startsWith('image/')));
                }
                m.toolCalls.forEach(tc => {
                    if (!answered.has(tc.id)) {
                        out.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: 'Ejecución interrumpida (sin resultado).' });
                    }
                });
                const imgMsg = toolImagesMessage(toolImages, provider);
                if (imgMsg) out.push(imgMsg);
            } else if (msg.content || msg.anthropic_content) {
                out.push(msg);
            }
        }
        // 'system' (errores mostrados en UI) y 'tool' sueltos se ignoran
    }
    return out;
};

// ============================================================================
// PROVIDER-SPECIFIC REQUEST BUILDERS
// ============================================================================

/**
 * Construye el payload de request específico para Google Gemini.
 *
 * EDUCATIVO: Gemini usa un formato diferente a OpenAI:
 * - 'contents' en lugar de 'messages', roles 'user' y 'model'
 * - 'parts' para contenido multimodal (text, inlineData, functionCall, functionResponse)
 * - 'systemInstruction' separado del array de contenidos
 * - Las llamadas a herramientas son parts `functionCall` y sus resultados
 *   parts `functionResponse` (no existe el rol 'tool')
 * - Gemini 3 exige devolver la `thoughtSignature` de cada functionCall
 */
const buildGeminiRequest = (apiMessages: any[], tools: any[]) => {
    const contents: any[] = [];

    const push = (role: 'user' | 'model', parts: any[]) => {
        if (parts.length === 0) return;
        const last = contents[contents.length - 1];
        // Gemini exige alternar roles: fusionamos mensajes consecutivos del mismo rol
        if (last && last.role === role) last.parts.push(...parts);
        else contents.push({ role, parts });
    };

    const dataUrlToInline = (url: string) => {
        const match = (url || '').match(/^data:([^;]+);base64,(.+)$/);
        return match ? { inlineData: { mimeType: match[1], data: match[2] } } : null;
    };

    apiMessages.forEach(m => {
        if (m.role === 'system') return;

        if (m.role === 'tool') {
            // Si Gemini asignó un id a la functionCall, hay que devolverlo en la respuesta
            const hasRealId = m.tool_call_id && !String(m.tool_call_id).startsWith('gemini-');
            push('user', [{
                functionResponse: { name: m.name, ...(hasRealId ? { id: m.tool_call_id } : {}), response: { result: m.content } }
            }]);
            return;
        }

        const parts: any[] = [];
        if (typeof m.content === 'string') {
            if (m.content) parts.push({ text: m.content });
        } else if (Array.isArray(m.content)) {
            m.content.forEach((c: any) => {
                if (c.type === 'text' && c.text) parts.push({ text: c.text });
                else if (c.type === 'image_url') { const p = dataUrlToInline(c.image_url?.url); if (p) parts.push(p); }
                else if (c.type === 'file') { const p = dataUrlToInline(c.file?.file_data); if (p) parts.push(p); }
            });
        }

        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            m.tool_calls.forEach((tc: ToolCall) => {
                let args = {};
                try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* args vacíos */ }
                parts.push({
                    functionCall: { name: tc.function.name, args },
                    ...(tc.thought_signature ? { thoughtSignature: tc.thought_signature } : {})
                });
            });
        }

        push(m.role === 'assistant' ? 'model' : 'user', parts);
    });

    const systemInstruction = apiMessages.find(m => m.role === 'system')?.content;

    return {
        contents,
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
        ...(tools.length > 0 ? {
            tools: [{
                // parametersJsonSchema acepta JSON Schema completo (lo que devuelven los servidores MCP)
                functionDeclarations: tools.map(t => ({
                    name: t.function.name,
                    description: t.function.description,
                    parametersJsonSchema: t.function.parameters
                }))
            }]
        } : {})
    };
};

/** Los proveedores OpenAI-compatibles no conocen `thought_signature`. */
const toOpenAIMessages = (apiMessages: any[]) => apiMessages.map(({ anthropic_content, ...m }) => {
    if (!m.tool_calls) return m;
    return {
        ...m,
        content: m.content || null,
        tool_calls: m.tool_calls.map(({ thought_signature, ...tc }: ToolCall) => tc)
    };
});

/**
 * Realiza la llamada HTTP al proveedor de LLM seleccionado.
 *
 * EDUCATIVO: Esta función abstrae las diferencias entre proveedores:
 * - Gemini: URL con modelo, key en header x-goog-api-key
 * - OpenAI/Groq/etc: Bearer token, formato estándar
 * - Custom: URL configurable, formato OpenAI-compatible
 */
const callLLMProvider = async (
    provider: Provider,
    key: string,
    model: string,
    apiMessages: any[],
    tools: any[],
    settings: AppSettings,
    signal?: AbortSignal,
    onDelta?: (text: string) => void
) => {
    if (provider === 'anthropic') return callAnthropic(key, model, apiMessages, tools, signal, onDelta);

    let endpoint = PROVIDER_ENDPOINTS[provider].chat;
    const stream = !!onDelta;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let requestPayload: any;

    // Configuración específica por proveedor
    if (provider === 'gemini') {
        endpoint = endpoint.replace('{model}', encodeURIComponent(model));
        // Streaming en Gemini: otro método (streamGenerateContent) y SSE con alt=sse
        if (stream) endpoint = endpoint.replace(':generateContent', ':streamGenerateContent') + '?alt=sse';
        headers['x-goog-api-key'] = key;
        requestPayload = buildGeminiRequest(apiMessages, tools);
    } else {
        if (provider === 'custom1' || provider === 'custom2') {
            const customUrl = provider === 'custom1' ? settings.custom1Url : settings.custom2Url;
            endpoint = `${customUrl.replace(/\/+$/, '')}/chat/completions`;
        }
        // Formato estándar OpenAI-compatible
        headers['Authorization'] = `Bearer ${key}`;
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = window.location.origin;
            headers['X-Title'] = 'Nodemat Chat';
        }
        requestPayload = {
            model: model,
            messages: toOpenAIMessages(apiMessages),
            tools: tools.length > 0 ? tools : undefined,
            tool_choice: tools.length > 0 ? "auto" : undefined,
            ...(stream ? { stream: true } : {}),
            // Sin esto, OpenAI no informa el uso de tokens cuando hay streaming
            ...(stream && STREAM_USAGE_PROVIDERS.includes(provider) ? { stream_options: { include_usage: true } } : {})
        };
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestPayload),
        signal
    });

    if (!response.ok) {
        const text = await response.text();
        let msg = `API Error ${response.status}`;
        try {
            const err = JSON.parse(text);
            msg = err.error?.message || err.message || msg;
        } catch {
            if (text) msg += `: ${text.slice(0, 300)}`;
        }
        throw new Error(msg);
    }

    // Algunos proveedores compatibles ignoran `stream`: entonces llega JSON común
    const isSSE = (response.headers.get('content-type') || '').includes('text/event-stream');
    if (stream && isSSE && response.body) {
        const data = provider === 'gemini'
            ? await collectGeminiStream(response.body, onDelta!)
            : await collectOpenAIStream(response.body, onDelta!);
        return { data, requestPayload };
    }
    const responseData = await response.json();
    return { data: responseData, requestPayload };
};

// ============================================================================
// STREAMING
// ============================================================================

/**
 * EDUCATIVO: con `stream: true` la API no devuelve una respuesta sino muchos
 * pedacitos (chunks) por SSE. Cada uno trae un `delta`: unas palabras de texto
 * o un fragmento de una llamada a herramienta (¡los argumentos JSON también
 * llegan por partes!). Acá los vamos juntando y al final armamos el mismo
 * objeto que devolvería la API sin streaming, así el resto del código no cambia.
 */
export async function collectOpenAIStream(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void) {
    let content = '';
    let id: string | undefined;
    let usage: any;
    const images: any[] = [];
    const toolCalls: any[] = [];
    let streamError: string | undefined;

    await readSSE(body, (_event, data) => {
        if (data.trim() === '[DONE]') return true;
        let chunk: any;
        try { chunk = JSON.parse(data); } catch { return; }
        if (chunk.error) { streamError = chunk.error.message || JSON.stringify(chunk.error); return true; }
        id = id || chunk.id;
        usage = chunk.usage || chunk.x_groq?.usage || usage;
        const delta = chunk.choices?.[0]?.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            onDelta(content);
        }
        if (Array.isArray(delta.images)) images.push(...delta.images);
        (delta.tool_calls || []).forEach((tc: any) => {
            const i = tc.index ?? toolCalls.length;
            const cur = toolCalls[i] || (toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.function.name += tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        });
    });

    if (streamError) throw new Error(streamError);
    const calls = toolCalls.filter(Boolean).map((tc, i) => ({ ...tc, id: tc.id || `call_${Date.now()}_${i}` }));
    return {
        id,
        usage,
        choices: [{ message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}), ...(images.length ? { images } : {}) } }]
    };
}

/** Gemini manda respuestas parciales completas: se concatenan las `parts`. */
export async function collectGeminiStream(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void) {
    const parts: any[] = [];
    let text = '';
    let usageMetadata: any;
    let responseId: string | undefined;
    let promptFeedback: any;

    await readSSE(body, (_event, data) => {
        let chunk: any;
        try { chunk = JSON.parse(data); } catch { return; }
        if (chunk.error) throw new Error(chunk.error.message || 'Error de Gemini');
        usageMetadata = chunk.usageMetadata || usageMetadata;
        responseId = responseId || chunk.responseId;
        promptFeedback = chunk.promptFeedback || promptFeedback;
        (chunk.candidates?.[0]?.content?.parts || []).forEach((p: any) => {
            const last = parts[parts.length - 1];
            // Los pedazos de texto consecutivos son UNA parte (si no, quedarían saltos de línea de más)
            if (typeof p.text === 'string' && last && typeof last.text === 'string' && !!last.thought === !!p.thought && !p.thoughtSignature) {
                last.text += p.text;
            } else {
                parts.push({ ...p });
            }
            if (typeof p.text === 'string' && !p.thought) {
                text += p.text;
                onDelta(text);
            }
        });
    });

    return {
        responseId,
        usageMetadata,
        ...(parts.length ? { candidates: [{ content: { role: 'model', parts } }] } : { promptFeedback })
    };
}

// ============================================================================
// RESPONSE PARSERS
// ============================================================================

interface ParsedResponse {
    content: string;
    toolCalls?: ToolCall[];
    images: Attachment[];
    /** Bloques originales (Claude) y resumen del razonamiento */
    providerContent?: any[];
    reasoning?: string;
}

/**
 * Parsea la respuesta de Google Gemini a un formato unificado.
 * Incluye imágenes generadas (inlineData) por modelos como gemini-2.5-flash-image.
 */
const parseGeminiResponse = (data: any): ParsedResponse => {
    const candidate = data.candidates?.[0];
    const parts: any[] = candidate?.content?.parts || [];

    if (!candidate) {
        const reason = data.promptFeedback?.blockReason;
        throw new Error(reason ? `Gemini bloqueó el mensaje (${reason}).` : 'Gemini no devolvió candidatos.');
    }

    const textParts = parts.filter(p => p.text && !p.thought).map(p => p.text);
    const images: Attachment[] = parts
        .filter(p => p.inlineData?.mimeType?.startsWith('image/'))
        .map((p, i) => ({
            name: `gemini-image-${i + 1}.${p.inlineData.mimeType.split('/')[1]}`,
            type: p.inlineData.mimeType,
            data: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`
        }));

    const functionCalls = parts.filter(p => p.functionCall);
    return {
        content: textParts.join('\n'),
        images,
        toolCalls: functionCalls.length > 0 ? functionCalls.map((p, i) => ({
            id: p.functionCall.id || `gemini-${Date.now()}-${i}`,
            type: 'function' as const,
            function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
            ...(p.thoughtSignature ? { thought_signature: p.thoughtSignature } : {})
        })) : undefined
    };
};

/**
 * Parsea respuestas OpenAI-compatibles.
 * OpenRouter devuelve imágenes generadas en `choices[0].message.images`
 * como `{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }`.
 */
const parseOpenAIResponse = (data: any): ParsedResponse => {
    const choice = data.choices?.[0];
    if (!choice) throw new Error(data.error?.message || 'La API no devolvió ninguna respuesta (choices vacío).');
    const message = choice.message || {};

    let content = '';
    if (typeof message.content === 'string') content = message.content;
    else if (Array.isArray(message.content)) {
        content = message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    }

    const rawImages: any[] = message.images || choice.images || [];
    const images: Attachment[] = rawImages
        .map((img: any) => img?.image_url?.url || img?.url)
        .filter(Boolean)
        .map((url: string, i: number) => {
            const mime = url.match(/^data:([^;]+);/)?.[1] || 'image/png';
            return { name: `imagen-${i + 1}.${mime.split('/')[1] || 'png'}`, type: mime, data: url };
        });

    return {
        content,
        images,
        toolCalls: message.tool_calls?.length ? message.tool_calls : undefined,
        providerContent: data.anthropic_content,
        reasoning: data.reasoning || (typeof message.reasoning === 'string' ? message.reasoning : undefined)
    };
};

// ============================================================================
// CHATGPT (CUENTA) - Responses API vía /api/chatgpt
// ============================================================================

/**
 * EDUCATIVO: la Responses API no usa `messages` sino una lista de "items":
 * - mensajes:           { type: 'message', role, content: [{ type: 'input_text' | 'output_text', text }] }
 * - llamadas a tools:   { type: 'function_call', call_id, name, arguments }
 * - resultados:         { type: 'function_call_output', call_id, output }
 * El system prompt va como mensaje de rol 'developer' (igual que hace Codex).
 */
const toResponsesInput = (apiMessages: any[]) => {
    const items: any[] = [];
    apiMessages.forEach(m => {
        if (m.role === 'system') {
            items.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: m.content }] });
        } else if (m.role === 'user') {
            const parts = typeof m.content === 'string'
                ? [{ type: 'input_text', text: m.content }]
                : m.content.map((c: any) =>
                    c.type === 'image_url' ? { type: 'input_image', image_url: c.image_url.url }
                        : c.type === 'file' ? { type: 'input_file', filename: c.file.filename, file_data: c.file.file_data }
                            : { type: 'input_text', text: c.text || '' });
            items.push({ type: 'message', role: 'user', content: parts });
        } else if (m.role === 'assistant') {
            if (m.content) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
            (m.tool_calls || []).forEach((tc: ToolCall) => items.push({
                type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}'
            }));
        } else if (m.role === 'tool') {
            items.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content || '' });
        }
    });
    return items;
};

const callChatGPT = async (
    model: string,
    apiMessages: any[],
    tools: any[],
    settings: AppSettings,
    options: { signal?: AbortSignal; onSettingsPatch?: (p: Partial<AppSettings>) => void; sessionId?: string; onDelta?: (text: string) => void }
): Promise<{ data: any; requestPayload: any; parsed: ParsedResponse }> => {
    const requestPayload = {
        model,
        stream: true,            // el backend de Codex sólo responde en streaming
        store: false,            // y no guarda las conversaciones
        input: toResponsesInput(apiMessages),
        tools: tools.map(t => ({
            type: 'function',
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
            strict: false
        })),
        tool_choice: 'auto',
        parallel_tool_calls: false,
        include: [],
        prompt_cache_key: options.sessionId
    };

    // Los refresh tokens rotan: tras renovar hay que usar SIEMPRE el nuevo
    let current = settings;
    const onRefreshed = (p: Partial<AppSettings>) => { current = { ...current, ...p }; options.onSettingsPatch?.(p); };

    let auth = await ensureFreshChatGPTToken(current, onRefreshed);
    const send = () => fetch(`${CHATGPT_BRIDGE_PATH}?action=responses`, {
        method: 'POST',
        headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ access_token: auth.accessToken, account_id: auth.accountId, session_id: options.sessionId, body: requestPayload }),
        signal: options.signal
    });

    let res = await send();
    if (res.status === 401) {
        // Puede ser el token del proxy (NODEMAT_PROXY_TOKEN), no la sesión de ChatGPT
        const text = await res.clone().text();
        if (/Token del proxy/i.test(text)) throw new Error('El token del proxy es inválido o falta. Revísalo en Ajustes → MCP → "Token del proxy".');
        // Token de ChatGPT rechazado: forzar renovación una vez
        auth = await ensureFreshChatGPTToken(current, onRefreshed, true);
        res = await send();
    }
    if (res.status === 400) {
        // Versiones anteriores del backend exigían el campo `instructions`: reintentar con él
        const text = await res.clone().text();
        if (/instructions/i.test(text) && !('instructions' in requestPayload)) {
            (requestPayload as any).instructions = apiMessages.find(m => m.role === 'system')?.content || '';
            res = await send();
        }
    }
    if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try { msg = JSON.parse(text).error || text; } catch { /* texto plano */ }
        if (res.status === 404 && /<html|NOT_FOUND/i.test(text)) msg = 'No se encontró /api/chatgpt (sólo existe en Vercel o con npm run dev).';
        if (res.status === 429) msg = `Alcanzaste el límite de uso de tu plan de ChatGPT. ${msg}`;
        if (res.status === 403) msg = `ChatGPT rechazó la petición (403). Puede que tu plan no incluya este acceso o que OpenAI haya bloqueado el origen. ${msg}`;
        throw new Error(String(msg).slice(0, 500));
    }
    if (!res.body) throw new Error('Respuesta vacía de ChatGPT.');

    const items: any[] = [];
    let completed: any = null;
    let failure: string | null = null;
    let streamed = '';

    await readSSE(res.body, (_event, raw) => {
        let ev: any;
        try { ev = JSON.parse(raw); } catch { return; }
        switch (ev.type) {
            case 'response.output_text.delta':
                if (typeof ev.delta === 'string') { streamed += ev.delta; options.onDelta?.(streamed); }
                break;
            case 'response.output_item.done':
                if (ev.item) items.push(ev.item);
                break;
            case 'response.completed':
            case 'response.incomplete':
                completed = ev.response;
                return true;
            case 'response.failed':
                failure = ev.response?.error?.message || 'La respuesta falló.';
                return true;
            case 'error':
                failure = ev.message || ev.error?.message || 'Error en el stream.';
                return true;
        }
    });

    if (failure) throw new Error(`ChatGPT: ${failure}`);

    const output = items.length ? items : (completed?.output || []);
    const text = output
        .filter((it: any) => it.type === 'message')
        .flatMap((it: any) => it.content || [])
        .filter((c: any) => c.type === 'output_text')
        .map((c: any) => c.text)
        .join('');
    const toolCalls: ToolCall[] = output
        .filter((it: any) => it.type === 'function_call')
        .map((it: any) => ({ id: it.call_id, type: 'function' as const, function: { name: it.name, arguments: it.arguments || '{}' } }));

    return {
        data: { id: completed?.id, usage: completed?.usage, output },
        requestPayload,
        parsed: { content: text, images: [], toolCalls: toolCalls.length ? toolCalls : undefined }
    };
};

/** API key y modelo del proveedor activo (con modelos por defecto razonables). */
export const resolveProvider = (settings: AppSettings): { key: string; model: string } => {
    const map: Record<Provider, { key: string; model: string }> = {
        groq: { key: settings.groqKey, model: settings.groqModel || 'llama-3.1-8b-instant' },
        openrouter: { key: settings.openRouterKey, model: settings.openRouterModel || 'openai/gpt-4o-mini' },
        openai: { key: settings.openaiKey, model: settings.openaiModel || 'gpt-4o-mini' },
        anthropic: { key: settings.anthropicKey, model: settings.anthropicModel || ANTHROPIC_DEFAULT_MODEL },
        cerebras: { key: settings.cerebrasKey, model: settings.cerebrasModel || 'llama3.1-8b' },
        gemini: { key: settings.geminiKey, model: settings.geminiModel || 'gemini-2.5-flash' },
        xai: { key: settings.xaiKey, model: settings.xaiModel || 'grok-3-mini' },
        custom1: { key: settings.custom1Key, model: settings.custom1Model },
        custom2: { key: settings.custom2Key, model: settings.custom2Model },
        chatgpt: { key: settings.chatgptKey, model: settings.chatgptModel || 'gpt-5' }
    };

    return map[settings.activeProvider];
};

/**
 * Una sola respuesta del modelo activo, sin herramientas.
 * La usa el "sampling" de MCP: un servidor le pide a NUESTRO modelo que genere
 * texto (por ejemplo, para resumir algo dentro de una herramienta).
 */
export const completeOnce = async (
    settings: AppSettings,
    messages: { role: 'user' | 'assistant'; content: any }[],
    options: { systemPrompt?: string; signal?: AbortSignal; onSettingsPatch?: (p: Partial<AppSettings>) => void } = {}
): Promise<{ text: string; model: string }> => {
    const { key, model } = resolveProvider(settings);
    if (!key) throw new Error('No hay un proveedor de IA conectado.');
    const apiMessages = [
        ...(options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
        ...messages
    ];
    if (settings.activeProvider === 'chatgpt') {
        const { parsed } = await callChatGPT(model, apiMessages, [], settings, { signal: options.signal, onSettingsPatch: options.onSettingsPatch });
        return { text: parsed.content, model };
    }
    const { data } = await callLLMProvider(settings.activeProvider, key, model, apiMessages, [], settings, options.signal);
    const parsed = settings.activeProvider === 'gemini' ? parseGeminiResponse(data) : parseOpenAIResponse(data);
    return { text: parsed.content, model };
};

// ============================================================================
// MAIN MESSAGE FLOW
// ============================================================================

export interface ToolApprovalRequest {
    toolName: string;        // nombre expuesto al LLM
    originalName: string;    // nombre real en el servidor MCP
    serverName: string;
    description?: string;
    args: any;
    annotations?: MCPTool['annotations'];
}

export interface SendMessageOptions {
    /** Pide confirmación al usuario. Devuelve true si aprueba. */
    onToolApproval: (req: ToolApprovalRequest) => Promise<boolean>;
    /** Se llama cada vez que se genera un mensaje nuevo (para mostrar progreso). */
    onUpdate?: (messages: Message[]) => void;
    signal?: AbortSignal;
    /** Para persistir cambios de ajustes hechos durante el envío (p. ej. token de ChatGPT renovado). */
    onSettingsPatch?: (patch: Partial<AppSettings>) => void;
    /** Identificador estable de la conversación (cache de prompts en ChatGPT). */
    sessionId?: string;
    /**
     * Texto parcial de la respuesta mientras el modelo la escribe (streaming).
     * null = terminó ese turno. Si no se pasa, no se pide streaming.
     */
    onStream?: (partialText: string | null) => void;
    /** Avisos de progreso de una herramienta en curso (si el servidor los manda). */
    onToolProgress?: (toolName: string, progress: MCPProgress | null) => void;
}

/**
 * Función principal para enviar un mensaje y obtener respuesta del LLM.
 *
 * EDUCATIVO: Esta función implementa el "Agentic Loop":
 * 1. Enviar el historial (el último mensaje es el del usuario)
 * 2. Si el modelo solicita ejecutar herramientas -> pedir aprobación
 * 3. Ejecutar herramientas aprobadas en el servidor MCP
 * 4. Enviar resultados al modelo
 * 5. Repetir hasta que el modelo dé una respuesta final
 *
 * @param settings - Configuración completa de la app
 * @param history - Historial completo, INCLUYENDO el mensaje nuevo del usuario
 * @returns Mensajes nuevos generados (llamadas a tools, resultados y respuesta final)
 */
export const sendMessage = async (
    settings: AppSettings,
    history: Message[],
    options: SendMessageOptions
): Promise<Message[]> => {
    const { onToolApproval, onUpdate, signal } = options;
    const { activeProvider } = settings;

    const { key, model } = resolveProvider(settings);

    if (!key) throw new Error(`La API Key para ${activeProvider} no está configurada.`);

    // 1. System prompt + herramientas MCP activas
    let systemInstruction = settings.systemPrompt || "Eres Nodemat AI. Responde en el idioma del usuario. Si usas herramientas, usa la información que te devuelven para construir tu respuesta final.";

    const { bindings, defs: activeToolsDefs } = buildToolRegistry(settings.mcpServers);

    const fileRefs = buildFileRefs(history);

    // Herramienta interna de imágenes (si el usuario eligió un modelo para el chat)
    const imageTool = settings.imageTool?.enabled && imageCredentials(settings, settings.imageTool.provider).apiKey ? settings.imageTool : null;
    if (imageTool) activeToolsDefs.push(imageToolDefinition(imageTool.model));

    if (activeToolsDefs.length > 0) {
        systemInstruction += "\n\nTienes acceso a herramientas externas (MCP). Úsalas cuando sea necesario.";
        if (fileRefs.size > 0) {
            systemInstruction += "\n\nArchivos de esta conversación que puedes pasarle a una herramienta: usa la referencia como valor del argumento " +
                "y Nodemat la reemplaza por el contenido (base64 si es binario, texto si es texto; agrega ?formato=dataurl para una data URL " +
                "o ?formato=texto para el texto extraído):\n" +
                [...fileRefs.entries()].map(([ref, att]) => `- ${ref} (${att.type || 'desconocido'}${att.size ? `, ${att.size} bytes` : ''})`).join('\n');
        }
        // La spec MCP permite que el servidor envíe "instructions" para el modelo
        const withInstructions = new Set(Object.values(bindings).map(b => b.server));
        withInstructions.forEach(s => {
            if (s.instructions) systemInstruction += `\n\n[Instrucciones del servidor ${s.serverInfo?.name || s.url}]\n${s.instructions}`;
        });
    }

    // 2. Historial en formato API (el mensaje actual ya está incluido al final)
    const apiMessages: any[] = [
        { role: 'system', content: systemInstruction },
        ...toApiMessages(history, activeProvider)
    ];

    // Copia viva de los ajustes: si se renueva el token de ChatGPT, los turnos siguientes usan el nuevo
    let liveSettings = settings;
    const patchSettings = (p: Partial<AppSettings>) => { liveSettings = { ...liveSettings, ...p }; options.onSettingsPatch?.(p); };

    // 3. Loop agéntico
    const generated: Message[] = [];
    const emit = (m: Message) => { generated.push(m); onUpdate?.([...generated]); };

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        let data: any, requestPayload: any, parsed: ParsedResponse;
        if (activeProvider === 'chatgpt') {
            ({ data, requestPayload, parsed } = await callChatGPT(model, apiMessages, activeToolsDefs, liveSettings, {
                signal, onSettingsPatch: patchSettings, sessionId: options.sessionId, onDelta: options.onStream
            }));
        } else {
            ({ data, requestPayload } = await callLLMProvider(activeProvider, key, model, apiMessages, activeToolsDefs, settings, signal, options.onStream));
            parsed = activeProvider === 'gemini' ? parseGeminiResponse(data) : parseOpenAIResponse(data);
        }
        options.onStream?.(null);

        const usage = data.usage ? {
            input: data.usage.prompt_tokens || data.usage.input_tokens || 0,
            output: data.usage.completion_tokens || data.usage.output_tokens || 0,
            total: data.usage.total_tokens || 0
        } : data.usageMetadata ? {
            input: data.usageMetadata.promptTokenCount || 0,
            output: data.usageMetadata.candidatesTokenCount || 0,
            total: data.usageMetadata.totalTokenCount || 0
        } : undefined;

        const rawDebug = {
            requestId: data.id || data.responseId || `req-${Date.now()}`,
            provider: activeProvider,
            model,
            requestPayload,
            responsePayload: data
        };

        if (!parsed.toolCalls || parsed.toolCalls.length === 0) {
            // Respuesta final
            emit({
                id: uid(),
                role: 'model',
                content: parsed.content,
                attachments: parsed.images.length ? parsed.images : undefined,
                providerContent: parsed.providerContent,
                reasoning: parsed.reasoning,
                timestamp: Date.now(),
                usage,
                rawDebug
            });
            return generated;
        }

        // El modelo quiere ejecutar herramientas
        apiMessages.push({ role: 'assistant', content: parsed.content, tool_calls: parsed.toolCalls, anthropic_content: parsed.providerContent });
        emit({
            id: uid(),
            role: 'model',
            content: parsed.content,
            toolCalls: parsed.toolCalls,
            providerContent: parsed.providerContent,
            reasoning: parsed.reasoning,
            timestamp: Date.now(),
            usage,
            rawDebug
        });

        const turnImages: Attachment[] = [];
        for (const toolCall of parsed.toolCalls) {
            const fnName = toolCall.function.name;
            const binding = bindings[fnName];

            let args: any = {};
            let argsError = false;
            let validation: ReturnType<typeof validateArgs> | undefined;
            try {
                args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
            } catch {
                argsError = true;
            }

            let resultText: string;
            let images: Attachment[] = [];
            let isError = false;
            let denied = false;
            const started = performance.now();

            if (fnName === IMAGE_TOOL_NAME && imageTool && !argsError) {
                const approved = imageTool.autoApprove || await onToolApproval({
                    toolName: fnName,
                    originalName: 'Generar imagen',
                    serverName: `Nodemat · ${imageTool.model}`,
                    description: 'Genera una imagen con el proveedor configurado (consume tu cuota de ese proveedor).',
                    args,
                    annotations: { readOnlyHint: true, openWorldHint: true }
                });
                if (signal?.aborted) throw new DOMException('Cancelado por el usuario', 'AbortError');
                if (approved) {
                    const r = await runImageTool(args, liveSettings, fileRefs, signal);
                    resultText = r.text;
                    images = r.images;
                    isError = r.isError;
                    // Las imágenes nuevas quedan disponibles para editarlas en el siguiente turno
                    images.forEach(img => fileRefs.set(FILE_REF_PREFIX + encodeURIComponent(img.name), img));
                } else {
                    resultText = "El usuario rechazó la generación de la imagen.";
                    denied = true;
                }
            } else if (!binding) {
                resultText = `Error: la herramienta "${fnName}" no existe o su servidor está desconectado.`;
                isError = true;
            } else if (argsError) {
                resultText = `Error: los argumentos no son JSON válido: ${toolCall.function.arguments}`;
                isError = true;
            } else if ((validation = validateArgs(binding.tool.inputSchema, args)).errors.length) {
                // Se le devuelve el error al modelo para que corrija y reintente
                resultText = `Error: argumentos inválidos para "${binding.originalName}": ${validation.errors.join('; ')}. Corrígelos y vuelve a intentar.`;
                isError = true;
            } else {
                args = validation.value;
                const serverName = binding.server.name || binding.server.serverInfo?.name || binding.server.url;
                const approved = binding.server.autoApprove || await onToolApproval({
                    toolName: fnName,
                    originalName: binding.originalName,
                    serverName,
                    description: binding.tool.description,
                    args,
                    annotations: binding.tool.annotations
                });

                if (signal?.aborted) throw new DOMException('Cancelado por el usuario', 'AbortError');

                if (approved) {
                    try {
                        const r = await callServerTool(binding.server, binding.originalName, resolveFileRefs(args, fileRefs), signal,
                            p => options.onToolProgress?.(binding.originalName, p));
                        resultText = r.text || '(sin contenido)';
                        images = r.attachments;
                        isError = r.isError;
                    } catch (err: any) {
                        if (err?.name === 'AbortError') throw err;
                        resultText = `Error ejecutando la herramienta: ${getFriendlyMCPError(err)}`;
                        isError = true;
                    } finally {
                        options.onToolProgress?.(binding.originalName, null);
                    }
                } else {
                    resultText = "El usuario rechazó la ejecución de esta herramienta.";
                    denied = true;
                }
            }

            apiMessages.push({ role: 'tool', tool_call_id: toolCall.id, name: fnName, content: resultText });
            // Las imágenes recién generadas no se le reenvían al modelo: ya sabe qué pidió
            if (fnName !== IMAGE_TOOL_NAME) turnImages.push(...images.filter(a => a.type.startsWith('image/')));
            emit({
                id: uid(),
                role: 'tool',
                content: resultText,
                tool_call_id: toolCall.id,
                name: fnName,
                attachments: images.length ? images : undefined,
                timestamp: Date.now(),
                toolMeta: {
                    serverName: fnName === IMAGE_TOOL_NAME ? `Nodemat · ${imageTool?.model}` : binding ? (binding.server.name || binding.server.serverInfo?.name || binding.server.url) : '—',
                    originalName: fnName === IMAGE_TOOL_NAME ? 'Generar imagen' : binding?.originalName || fnName,
                    args,
                    isError,
                    denied,
                    durationMs: Math.round(performance.now() - started)
                }
            });
        }
        const imgMsg = toolImagesMessage(turnImages, activeProvider);
        if (imgMsg) apiMessages.push(imgMsg);
    }

    // Límite de seguridad alcanzado
    emit({
        id: uid(),
        role: 'system',
        content: `⚠️ Se alcanzó el límite de ${MAX_TOOL_TURNS} rondas de herramientas sin una respuesta final.`,
        timestamp: Date.now()
    });
    return generated;
};
