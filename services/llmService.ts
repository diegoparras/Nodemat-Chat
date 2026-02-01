/**
 * ============================================================================
 * LLM SERVICE - Language Model API Orchestrator
 * ============================================================================
 * 
 * Este servicio orquesta todas las comunicaciones con los proveedores de LLM.
 * Proporciona una interfaz unificada para:
 * 
 * - Enviar mensajes a múltiples proveedores (Groq, OpenRouter, OpenAI, etc.)
 * - Ejecutar herramientas MCP (Model Context Protocol)
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
 * 
 * EDUCATIVO:
 * Este archivo es ideal para aprender cómo funcionan las APIs de LLM:
 * - Estructura de mensajes (roles: system, user, assistant, tool)
 * - Tool calling / Function calling
 * - Manejo de respuestas streaming vs batch
 */

import { AppSettings, Message, Provider, MCPTool, MCPServer, Attachment } from "../types";

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
    // Proveedores personalizados - URLs se configuran dinámicamente
    custom1: { chat: '', models: '' },
    custom2: { chat: '', models: '' }
};

/**
 * Modelos de respaldo cuando la API de /models falla.
 * Útil para UX más rápida y cuando CORS bloquea la petición inicial.
 */
const FALLBACK_MODELS: Partial<Record<Provider, string[]>> = {
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1-preview', 'o1-mini'],
    gemini: ['gemini-2.0-flash-exp', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro'],
    custom1: [],
    custom2: []
};

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Traduce errores técnicos de MCP a mensajes amigables para el usuario.
 * 
 * @param error - El error original capturado
 * @returns Mensaje de error legible en español con sugerencias de solución
 */
const getFriendlyMCPError = (error: any): string => {
    const msg = error.message || error.toString();

    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ECONNREFUSED')) {
        return "⚠️ No pudimos encontrar tu servidor.\n\n" +
            "Por favor revisa:\n" +
            "1. ¿Está tu servidor 'corriendo' o encendido en la terminal?\n" +
            "2. ¿La URL (ej. http://localhost:8000/sse) es exactamente la correcta?\n" +
            "3. (Avanzado) ¿Tu servidor permite conexiones externas (CORS)?";
    }
    if (msg.includes('401') || msg.includes('403')) return "🔒 Acceso denegado. Revisa tus credenciales.";
    if (msg.includes('404')) return "🔍 URL incompleta o incorrecta. ¿Falta '/messages' al final?";
    if (msg.includes('500')) return "💥 El servidor tuvo un problema interno al ejecutar la herramienta.";
    if (msg.includes('JSON') || msg.includes('Invalid response')) return "🤔 El servidor devolvió una respuesta inválida.";

    return `Ocurrió un error inesperado: "${msg}".`;
};

// ============================================================================
// MCP (MODEL CONTEXT PROTOCOL) EXECUTION
// ============================================================================

/**
 * Ejecuta una herramienta MCP en un servidor local del usuario.
 * 
 * MCP permite que la IA ejecute funciones en el entorno local:
 * - Consultar bases de datos
 * - Ejecutar comandos de terminal
 * - Acceder al sistema de archivos
 * 
 * SEGURIDAD: Esta función solo se ejecuta después de que el usuario
 * aprueba explícitamente la ejecución mediante el ToolApprovalModal.
 * 
 * @param server - Configuración del servidor MCP (URL, auth token)
 * @param toolName - Nombre de la herramienta a ejecutar
 * @param args - Argumentos para la herramienta (varían según la tool)
 * @returns Resultado de la ejecución como string
 */
const executeMCPToolCall = async (server: MCPServer, toolName: string, args: any): Promise<any> => {
    const rpcUrl = server.url;

    // Construir headers con autenticación opcional
    const headers: any = { 'Content-Type': 'application/json' };
    if (server.authToken) headers['Authorization'] = `Bearer ${server.authToken}`;

    // Payload JSON-RPC 2.0 estándar para MCP
    const payload = {
        jsonrpc: "2.0",
        id: Date.now(), // ID único para correlación
        method: "tools/call",
        params: {
            name: toolName,
            arguments: args
        }
    };

    const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`MCP Server Error (${response.status}): ${text}`);
    }

    const data = await response.json();

    // Manejar errores de nivel JSON-RPC
    if (data.error) throw new Error(data.error.message);

    // Extraer contenido de la respuesta según formato MCP
    if (data.result && data.result.content) {
        const textParts = data.result.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
        return textParts;
    }

    return JSON.stringify(data.result || data);
};

// ============================================================================
// API CALLS - MODEL FETCHING
// ============================================================================

/**
 * Obtiene la lista de modelos disponibles para un proveedor.
 * 
 * EDUCATIVO: Esta función demuestra cómo cada proveedor tiene
 * formatos de respuesta ligeramente diferentes para su API de models.
 * 
 * @param provider - El proveedor de IA
 * @param key - API key del proveedor
 * @param customUrl - URL base para proveedores personalizados
 * @returns Array de IDs de modelos disponibles
 */
export const fetchModels = async (provider: Provider, key: string, customUrl?: string): Promise<string[]> => {
    try {
        let endpoint = PROVIDER_ENDPOINTS[provider].models;

        // Para proveedores custom, usar la URL proporcionada
        if ((provider === 'custom1' || provider === 'custom2') && customUrl) {
            endpoint = `${customUrl}/models`;
        }

        if (!endpoint) {
            return FALLBACK_MODELS[provider] || [];
        }

        let headers: Record<string, string> = {};
        let url = endpoint;

        // Configuración específica de autenticación por proveedor
        if (provider === 'gemini') {
            // Gemini usa query param en lugar de header
            url = `${endpoint}?key=${key}`;
        } else {
            headers = { 'Authorization': `Bearer ${key}` };
            if (provider === 'openrouter') {
                // OpenRouter requiere HTTP-Referer para tracking
                headers['HTTP-Referer'] = window.location.origin;
            }
        }

        const response = await fetch(url, { method: 'GET', headers });

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
 * 
 * @param url - URL del servidor MCP
 * @param transport - Tipo de transporte (sse, stdio)
 * @param authType - Tipo de autenticación
 * @param token - Token de autenticación
 * @returns Array de definiciones de herramientas MCP
 */
export const connectToMCP = async (url: string, transport: string, authType: string, token: string): Promise<MCPTool[]> => {
    const headers: any = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
        const payload = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
        const response = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(payload) });

        if (!response.ok) throw new Error(`Server status ${response.status}`);
        const data = await response.json();

        if (data.error) throw new Error(`MCP Error: ${data.error.message}`);
        if (data.result && data.result.tools) return data.result.tools;
        if (Array.isArray(data)) return data;

        throw new Error("Invalid response format.");
    } catch (e) {
        throw e;
    }
};

// ============================================================================
// PROVIDER-SPECIFIC REQUEST BUILDERS
// ============================================================================

/**
 * Construye el payload de request específico para Google Gemini.
 * 
 * EDUCATIVO: Gemini usa un formato diferente a OpenAI:
 * - 'contents' en lugar de 'messages'
 * - 'parts' para contenido multimodal
 * - 'systemInstruction' separado del array de contenidos
 * 
 * @param apiMessages - Array de mensajes en formato OpenAI
 * @param tools - Definiciones de herramientas
 * @returns Payload formateado para la API de Gemini
 */
const buildGeminiRequest = (apiMessages: any[], tools: any[]) => {
    const contents = apiMessages
        .filter(m => m.role !== 'system')
        .map(m => {
            const parts: any[] = [];

            if (typeof m.content === 'string') {
                parts.push({ text: m.content });
            } else if (Array.isArray(m.content)) {
                m.content.forEach((c: any) => {
                    if (c.type === 'text') {
                        parts.push({ text: c.text });
                    } else if (c.type === 'image_url') {
                        // Extraer base64 y mime de Data URL
                        const url = c.image_url?.url || "";
                        const match = url.match(/^data:([^;]+);base64,(.+)$/);
                        if (match) {
                            const mimeType = match[1];
                            const data = match[2];

                            if (mimeType.startsWith('image/')) {
                                parts.push({
                                    inlineData: {
                                        mimeType: mimeType,
                                        data: data
                                    }
                                });
                            }
                        }
                    }
                });
            }

            return {
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: parts
            };
        });

    const systemInstruction = apiMessages.find(m => m.role === 'system')?.content;

    return {
        contents,
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
        ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools.map(t => t.function) }] } : {})
    };
};

/**
 * Realiza la llamada HTTP al proveedor de LLM seleccionado.
 * 
 * EDUCATIVO: Esta función abstrae las diferencias entre proveedores:
 * - Gemini: URL con modelo, key en query param
 * - OpenAI/Groq/etc: Bearer token, formato estándar
 * - Custom: URL configurable, formato OpenAI-compatible
 * 
 * @param provider - Proveedor seleccionado
 * @param key - API key
 * @param model - ID del modelo a usar
 * @param apiMessages - Historial de mensajes
 * @param tools - Definiciones de herramientas
 * @param settings - Configuración de la app
 * @returns Objeto con data de respuesta y payload original (para debug)
 */
const callLLMProvider = async (
    provider: Provider,
    key: string,
    model: string,
    apiMessages: any[],
    tools: any[],
    settings: AppSettings
) => {
    let endpoint = PROVIDER_ENDPOINTS[provider].chat;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let requestPayload: any;

    // Configuración específica por proveedor
    if (provider === 'gemini') {
        endpoint = endpoint.replace('{model}', model) + `?key=${key}`;
        requestPayload = buildGeminiRequest(apiMessages, tools);
    } else if (provider === 'custom1' || provider === 'custom2') {
        const customUrl = provider === 'custom1' ? settings.custom1Url : settings.custom2Url;
        endpoint = `${customUrl}/chat/completions`;
        headers['Authorization'] = `Bearer ${key}`;
        requestPayload = {
            model: model,
            messages: apiMessages,
            tools: tools.length > 0 ? tools : undefined,
            tool_choice: tools.length > 0 ? "auto" : undefined
        };
    } else {
        // Formato estándar OpenAI-compatible
        headers['Authorization'] = `Bearer ${key}`;
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = window.location.origin;
        }
        requestPayload = {
            model: model,
            messages: apiMessages,
            tools: tools.length > 0 ? tools : undefined,
            tool_choice: tools.length > 0 ? "auto" : undefined
        };
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || err.message || "API Error");
    }

    const responseData = await response.json();
    return { data: responseData, requestPayload };
};

// ============================================================================
// RESPONSE PARSERS
// ============================================================================

/**
 * Parsea la respuesta de Google Gemini a un formato unificado.
 * 
 * @param data - Respuesta raw de la API de Gemini
 * @returns Objeto con contenido de texto y optional tool calls
 */
const parseGeminiResponse = (data: any): { content: string; toolCalls?: any[] } => {
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text);
    const functionCalls = parts.filter((p: any) => p.functionCall);

    return {
        content: textParts.join('\n'),
        toolCalls: functionCalls.length > 0 ? functionCalls.map((fc: any) => ({
            id: `gemini-${Date.now()}`,
            type: 'function',
            function: { name: fc.functionCall.name, arguments: JSON.stringify(fc.functionCall.args) }
        })) : undefined
    };
};

// ============================================================================
// MAIN MESSAGE FLOW
// ============================================================================

/**
 * Función principal para enviar un mensaje y obtener respuesta del LLM.
 * 
 * EDUCATIVO: Esta función implementa el "Agentic Loop":
 * 1. Enviar mensaje del usuario
 * 2. Si el modelo solicita ejecutar herramientas -> pedir aprobación
 * 3. Ejecutar herramientas aprobadas
 * 4. Enviar resultados al modelo
 * 5. Repetir hasta que el modelo dé una respuesta final
 * 
 * @param settings - Configuración completa de la app
 * @param history - Historial de mensajes previos
 * @param currentMessage - Mensaje actual del usuario
 * @param attachments - Archivos adjuntos (imágenes, texto)
 * @param onToolApproval - Callback para aprobar/rechazar ejecución de herramientas
 * @returns Array de nuevos mensajes generados (puede incluir múltiples si hubo tool calling)
 */
export const sendMessage = async (
    settings: AppSettings,
    history: Message[],
    currentMessage: string,
    attachments: Attachment[],
    onToolApproval: (toolName: string, args: any) => Promise<boolean>
): Promise<Message[]> => {

    const { activeProvider } = settings;

    // Mapeo de keys y modelos por proveedor
    const providerKeyMap: Record<Provider, { key: string; model: string }> = {
        groq: { key: settings.groqKey, model: settings.groqModel || 'llama3-8b-8192' },
        openrouter: { key: settings.openRouterKey, model: settings.openRouterModel || 'openai/gpt-3.5-turbo' },
        openai: { key: settings.openaiKey, model: settings.openaiModel || 'gpt-4o-mini' },
        cerebras: { key: settings.cerebrasKey, model: settings.cerebrasModel || 'llama3.1-8b' },
        gemini: { key: settings.geminiKey, model: settings.geminiModel || 'gemini-1.5-flash' },
        xai: { key: settings.xaiKey, model: settings.xaiModel || 'grok-beta' },
        custom1: { key: settings.custom1Key, model: settings.custom1Model },
        custom2: { key: settings.custom2Key, model: settings.custom2Model }
    };

    const { key, model } = providerKeyMap[activeProvider];

    if (!key) throw new Error(`La API Key para ${activeProvider} no está configurada.`);

    // 1. Construir System Prompt con instrucciones sobre herramientas
    let systemInstruction = settings.systemPrompt || "Eres Nodemat AI. Responde en el idioma del usuario. Si usas herramientas, usa la información que te devuelven para construir tu respuesta final.";

    // Mapear herramientas MCP activas a definiciones para el LLM
    const toolMap: Record<string, MCPServer> = {};
    const activeToolsDefs: any[] = [];

    settings.mcpServers.forEach(server => {
        if (server.status === 'connected') {
            const enabled = server.tools.filter(t => server.enabledTools.includes(t.name));
            enabled.forEach(t => {
                toolMap[t.name] = server;
                activeToolsDefs.push({
                    type: "function",
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.inputSchema
                    }
                });
            });
        }
    });

    if (activeToolsDefs.length > 0) {
        systemInstruction += "\n\nTienes acceso a herramientas locales. Úsalas cuando sea necesario.";
    }

    // 2. Preparar historial de mensajes en formato API
    const apiMessages: any[] = [
        { role: 'system', content: systemInstruction }
    ];

    history.forEach(m => {
        if (m.role === 'tool') {
            apiMessages.push({
                role: 'tool',
                tool_call_id: m.tool_call_id,
                name: m.name,
                content: m.content
            });
        } else if (m.role === 'model') {
            const msg: any = { role: 'assistant', content: m.content };
            if (m.toolCalls) msg.tool_calls = m.toolCalls;
            apiMessages.push(msg);
        } else if (m.role === 'user') {
            if (m.attachments && m.attachments.length > 0) {
                const contentArray: any[] = [{ type: "text", text: m.content || "" }];
                m.attachments.forEach(att => {
                    const isNative = att.type.startsWith('image/');

                    if (isNative) {
                        contentArray.push({ type: "image_url", image_url: { url: att.data } });
                    } else {
                        // Archivos de texto se adjuntan inline
                        contentArray[0].text += `\n\n--- Archivo Adjunto: ${att.name} ---\n${att.data}\n-------------------`;
                    }
                });
                apiMessages.push({ role: 'user', content: contentArray });
            } else {
                apiMessages.push({ role: 'user', content: m.content });
            }
        }
    });

    // 3. Preparar mensaje actual del usuario
    let contentPayload: any = currentMessage;
    if (attachments.length > 0) {
        const contentArray: any[] = [{ type: "text", text: currentMessage }];
        attachments.forEach(att => {
            const isNative = att.type.startsWith('image/');

            if (isNative) {
                contentArray.push({ type: "image_url", image_url: { url: att.data } });
            } else {
                contentArray[0].text += `\n\n--- Archivo Adjunto: ${att.name} ---\n${att.data}\n-------------------`;
            }
        });
        contentPayload = contentArray;
    }

    apiMessages.push({ role: 'user', content: contentPayload });

    // 4. Loop de ejecución (máximo 5 turnos de tool calling)
    const newMessagesGenerated: Message[] = [];
    let keepGoing = true;
    let turns = 0;

    while (keepGoing && turns < 5) {
        turns++;

        const { data, requestPayload } = await callLLMProvider(activeProvider, key, model, apiMessages, activeToolsDefs, settings);

        // Parsear respuesta según proveedor
        let messageContent = '';
        let toolCalls: any[] | undefined;

        if (activeProvider === 'gemini') {
            const parsed = parseGeminiResponse(data);
            messageContent = parsed.content;
            toolCalls = parsed.toolCalls;
        } else {
            // Formato OpenAI-compatible
            const choice = data.choices[0];
            const messageData = choice.message;
            messageContent = messageData.content || '';
            toolCalls = messageData.tool_calls;
        }

        if (toolCalls && toolCalls.length > 0) {
            // El modelo quiere ejecutar herramientas
            apiMessages.push({ role: 'assistant', content: messageContent, tool_calls: toolCalls });

            for (const toolCall of toolCalls) {
                const fnName = toolCall.function.name;
                const fnArgsStr = toolCall.function.arguments;

                let executionResult = "";
                let args = {};

                try {
                    args = JSON.parse(fnArgsStr);
                } catch {
                    args = { error: "Invalid JSON args" };
                }

                if (toolMap[fnName]) {
                    // Pedir aprobación al usuario antes de ejecutar
                    const isApproved = await onToolApproval(fnName, args);

                    if (isApproved) {
                        try {
                            executionResult = await executeMCPToolCall(toolMap[fnName], fnName, args);
                        } catch (err: any) {
                            executionResult = `Error executing tool: ${err.message}`;
                        }
                    } else {
                        executionResult = "User denied execution of this tool.";
                    }
                } else {
                    executionResult = "Error: Tool not found or server disconnected.";
                }

                const toolMsg = {
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: fnName,
                    content: executionResult
                };
                apiMessages.push(toolMsg);
            }

        } else {
            // El modelo dio una respuesta final
            keepGoing = false;

            // Extraer imágenes de la respuesta si las hay
            let finalContent = messageContent;

            if (activeProvider === 'openrouter' || activeProvider === 'openai') {
                const choice = data.choices?.[0];
                const choiceImages = choice?.images;

                if (choiceImages && Array.isArray(choiceImages) && choiceImages.length > 0) {
                    const imageParts: string[] = [];
                    choiceImages.forEach((img: any) => {
                        if (img.image_url?.url) {
                            imageParts.push(`![Imagen Generada](${img.image_url.url})`);
                        }
                    });
                    if (imageParts.length > 0) {
                        finalContent = finalContent
                            ? finalContent + '\n\n' + imageParts.join('\n\n')
                            : imageParts.join('\n\n');
                    }
                }
            }

            const finalMsg: Message = {
                id: Date.now().toString(),
                role: 'model',
                content: finalContent,
                timestamp: Date.now(),
                usage: data.usage ? {
                    input: data.usage.prompt_tokens || data.usage.input_tokens || 0,
                    output: data.usage.completion_tokens || data.usage.output_tokens || 0,
                    total: data.usage.total_tokens || 0
                } : undefined,
                rawDebug: {
                    requestId: data.id || `req-${Date.now()}`,
                    provider: activeProvider,
                    model: model,
                    requestPayload: requestPayload,
                    responsePayload: data
                }
            };
            newMessagesGenerated.push(finalMsg);
        }
    }

    // Límite de seguridad alcanzado
    if (turns >= 5) {
        newMessagesGenerated.push({
            id: Date.now().toString(),
            role: 'model',
            content: "⚠️ Límite de ejecución de herramientas alcanzado.",
            timestamp: Date.now()
        });
    }

    return newMessagesGenerated;
};

export { getFriendlyMCPError };