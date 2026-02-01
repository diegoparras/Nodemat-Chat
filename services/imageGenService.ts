import { Provider } from "../types";

export interface ImageGenResponse {
    url?: string;
    revised_prompt?: string;
    error?: string;
    logs: any;
}

export const imageGenService = {
    async generateImage(
        prompt: string,
        model: string,
        apiKey: string,
        provider: Provider,
        size: string = "1024x1024"
    ): Promise<ImageGenResponse> {

        let endpoint = '';
        let requestBody: any = {};
        let headers: any = {
            "Content-Type": "application/json",
        };

        // --- Provider Routing ---

        if (provider === 'openai') {
            // OpenAI Native DALL-E
            endpoint = "https://api.openai.com/v1/images/generations";
            headers["Authorization"] = `Bearer ${apiKey}`;
            requestBody = {
                model: model.includes('dall-e') ? model : 'dall-e-3', // fallback to dall-e-3 if model name is weird
                prompt: prompt,
                n: 1,
                size: size
            };
        } else if (provider === 'openrouter') {
            // OpenRouter (Flux, SD, etc via Chat Completions)
            endpoint = "https://openrouter.ai/api/v1/chat/completions";
            headers["Authorization"] = `Bearer ${apiKey}`;
            requestBody = {
                model: model,
                messages: [{ role: "user", content: prompt }]
            };
            headers["HTTP-Referer"] = window.location.origin;
            headers["X-Title"] = "Nodemat Chat";
        } else if (provider === 'gemini') {
            // Google Imagen (Official API)
            // Note: Currently requires 'imagen-3.0-generate-001' mapping
            // Endpoint format: https://generativelanguage.googleapis.com/v1beta/models/<model>:predict?key=<key>
            const imageModel = 'imagen-3.0-generate-001';
            endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${imageModel}:predict?key=${apiKey}`;

            // Google Request Format
            requestBody = {
                instances: [
                    { prompt: prompt }
                ],
                parameters: {
                    sampleCount: 1,
                    aspectRatio: "1:1", // approximate for 1024x1024
                    outputOptions: { mimeType: "image/png" }
                }
            };
        } else {
            return {
                error: `La generación de imágenes con ${provider} no está soportada nativamente.`,
                logs: { provider }
            };
        }

        const logs: any = {
            timestamp: new Date().toISOString(),
            provider: provider,
            endpoint: endpoint.split('?')[0], // Hide key in logs
            request: {
                headers: { ...headers, "Authorization": headers.Authorization ? "Bearer [REDACTED]" : undefined },
                body: requestBody
                // Note: Key is in URL for Gemini, hidden above
            },
            response: null
        };

        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: headers,
                body: JSON.stringify(requestBody)
            });

            const data = await response.json();
            logs.response = {
                status: response.status,
                data: provider === 'gemini' ? { ...data, predictions: stringifyPredictions(data.predictions) } : data
            };

            if (!response.ok) {
                const errorMsg = data.error?.message || (data.error && JSON.stringify(data.error)) || `Error ${response.status}`;
                return {
                    error: mapProviderError(provider, errorMsg),
                    logs: logs
                };
            }

            // --- Response Parsing ---

            // OpenAI Format
            if (provider === 'openai') {
                const url = data.data?.[0]?.url;
                if (url) return { url, logs };
            }

            // Google Gemini (Imagen) Format
            if (provider === 'gemini') {
                // predictions[0].bytesBase64Encoded or similar
                // Actual format: { predictions: [ { bytesBase64Encoded: "..." } ] }
                const base64 = data.predictions?.[0]?.bytesBase64Encoded;
                if (base64) {
                    const url = `data:image/png;base64,${base64}`;
                    return { url, logs };
                }
                if (data.predictions?.[0]?.mimeType && data.predictions?.[0]?.bytesBase64Encoded) {
                    const url = `data:${data.predictions[0].mimeType};base64,${data.predictions[0].bytesBase64Encoded}`;
                    return { url, logs };
                }
            }

            // OpenRouter Format (Chat Completion)
            if (provider === 'openrouter') {
                const choice = data.choices?.[0];
                const messageContent = choice?.message?.content;
                const choiceImages = choice?.images; // Some generic OpenAI-compatible proxies

                // 1. Check choice.images (newer format)
                if (choiceImages && choiceImages.length > 0) {
                    const imgUrl = choiceImages[0]?.image_url?.url || choiceImages[0]?.url;
                    if (imgUrl) return { url: imgUrl, logs };
                }

                // 2. Check markdown in content
                if (typeof messageContent === 'string') {
                    const mdMatch = messageContent.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
                    if (mdMatch) return { url: mdMatch[1], logs };

                    const urlMatch = messageContent.match(/(https?:\/\/[^\s]+\.(png|jpg|jpeg|webp|gif))/i);
                    if (urlMatch) return { url: urlMatch[1], logs };
                }
            }

            return {
                error: "El modelo no devolvió una imagen en un formato conocido.",
                logs: logs
            };

        } catch (error: any) {
            logs.response = { error: error.message };
            return { error: error.message, logs: logs };
        }
    }
};

// Helpers
function mapProviderError(provider: string, msg: string): string {
    if (provider === 'gemini' && msg.includes('404')) return "Modelo de imagen no encontrado o API no habilitada en tu cuenta de Google.";
    if (msg.includes('401')) return "Error de autenticación: Verifica tu API Key.";
    return msg;
}

function stringifyPredictions(predictions: any[]) {
    if (!predictions) return null;
    return predictions.map(p => ({ ...p, bytesBase64Encoded: "[BASE64_IMAGE_DATA_HIDDEN]" }));
}

