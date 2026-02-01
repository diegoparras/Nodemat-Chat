import React, { useState, useEffect } from 'react';
import { X, Image as ImageIcon, Download, Terminal, Loader2, Sparkles, ChevronDown, RefreshCw } from 'lucide-react';
import { imageGenService } from '../services/imageGenService';
import { fetchModels } from '../services/llmService';
import { Provider, AppSettings, PROVIDER_NAMES } from '../types';

interface ImageGenModalProps {
    isOpen: boolean;
    onClose: () => void;
    settings: AppSettings;
}

export const ImageGenModal: React.FC<ImageGenModalProps> = ({ isOpen, onClose, settings }) => {
    const [provider, setProvider] = useState<Provider>('openrouter');
    const [models, setModels] = useState<string[]>([]);
    const [model, setModel] = useState('');
    const [prompt, setPrompt] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isLoadingModels, setIsLoadingModels] = useState(false);
    const [result, setResult] = useState<{ url: string | null, logs: any | null, error: string | null }>({ url: null, logs: null, error: null });
    const [showLogs, setShowLogs] = useState(false);

    // Maps to access settings dynamically
    const keyMap: Record<Provider, keyof AppSettings> = {
        groq: 'groqKey', openrouter: 'openRouterKey', openai: 'openaiKey',
        anthropic: 'anthropicKey', cerebras: 'cerebrasKey', gemini: 'geminiKey', xai: 'xaiKey', mistral: 'mistralKey'
    };
    const connectedMap: Record<Provider, keyof AppSettings> = {
        groq: 'groqConnected', openrouter: 'openRouterConnected', openai: 'openaiConnected',
        anthropic: 'anthropicConnected', cerebras: 'cerebrasConnected', gemini: 'geminiConnected', xai: 'xaiConnected', mistral: 'mistralConnected'
    };

    // Initialize provider when modal opens
    useEffect(() => {
        if (isOpen) {
            // If current provider is not connected, switch to first connected one
            const currentConnected = settings[connectedMap[provider]];
            if (!currentConnected) {
                const providers: Provider[] = ['openrouter', 'openai', 'groq', 'anthropic', 'cerebras', 'gemini', 'xai', 'mistral'];
                const firstConnected = providers.find(p => settings[connectedMap[p]]);
                if (firstConnected) {
                    setProvider(firstConnected);
                }
            }
        }
    }, [isOpen]);

    // Fetch models when provider changes
    useEffect(() => {
        const loadModels = async () => {
            const key = settings[keyMap[provider]] as string;

            if (!key) {
                setModels([]);
                return;
            }

            setIsLoadingModels(true);
            try {
                // For providers that don't support image gen natively via same endpoint, we might want to skip fetching or handle differently
                // But for "Same as main screen" consistency, we fetch what's available.

                const fetched = await fetchModels(provider, key);

                // Filter models that are likely for image generation
                // OpenRouter image models often contain 'flux', 'dall-e', 'stable-diffusion', 'imagen'
                const imageKeywords = ['flux', 'dall-e', 'stable-diffusion', 'imagen', 'sdxl', 'image', 'picture', 'photo'];

                // Special handling per provider if needed
                let filtered = fetched;

                if (provider === 'openrouter') {
                    filtered = fetched.filter(m => imageKeywords.some(kw => m.toLowerCase().includes(kw)));
                }
                // OpenAI usually returns text models via standard fetch. DALL-E needs special handling or might not be in the list.
                // We'll keep the list generic if filtering yields nothing.

                const finalModels = filtered.length > 0 ? filtered : fetched;

                setModels(finalModels);
                // Set default model if current selection is invalid
                if (!finalModels.includes(model)) {
                    setModel(finalModels[0] || '');
                }
            } catch (e) {
                console.error("Failed to fetch models", e);
                setModels([]);
            } finally {
                setIsLoadingModels(false);
            }
        };

        if (isOpen) {
            loadModels();
        }
    }, [provider, isOpen, settings]); // Re-run if settings change (e.g. key update)

    if (!isOpen) return null;

    const currentKey = settings[keyMap[provider]] as string;
    const isConnected = !!currentKey;

    // Get list of connected providers for dropdown
    const connectedProviders = (Object.keys(PROVIDER_NAMES) as Provider[]).filter(p => settings[connectedMap[p]]);
    // If no providers connected, show at least the current one (or all)
    const providerOptions = connectedProviders.length > 0 ? connectedProviders : (Object.keys(PROVIDER_NAMES) as Provider[]);

    const handleGenerate = async () => {
        if (!prompt.trim() || !model) return;
        if (!currentKey) {
            setResult({ url: null, error: `Falta la API Key de ${PROVIDER_NAMES[provider]} en Ajustes`, logs: { note: "Local Check Failed" } });
            return;
        }

        setIsLoading(true);
        setResult({ url: null, logs: null, error: null });

        try {
            const response = await imageGenService.generateImage(prompt, model, currentKey, provider);
            setResult({
                url: response.url || null,
                logs: response.logs,
                error: response.error || null
            });
        } catch (e: any) {
            setResult({
                url: null,
                logs: { error: e.message },
                error: "Error inesperado"
            });
        } finally {
            setIsLoading(false);
        }
    };

    const handleDownload = () => {
        if (result.url) {
            const a = document.createElement('a');
            a.href = result.url;
            a.download = `nodemat_gen_${Date.now()}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in">
            <div className="bg-surface border border-border rounded-2xl w-full max-w-4xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">

                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-border bg-surface-highlight/30">
                    <div className="flex items-center gap-2">
                        <div className="p-2 bg-purple-100 dark:bg-purple-900/30 text-purple-600 rounded-lg">
                            <Sparkles size={20} />
                        </div>
                        <h3 className="font-bold text-lg text-text-main">Generador de Imágenes</h3>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-surface-highlight rounded-lg transition-colors text-text-muted">
                        <X size={20} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 md:flex gap-6">

                    {/* Left: Controls */}
                    <div className="w-full md:w-1/3 space-y-4 flex flex-col">

                        {/* Provider Selector */}
                        <div>
                            <label className="block text-xs font-bold text-text-muted uppercase mb-1">Proveedor</label>
                            <div className="relative">
                                <select
                                    value={provider}
                                    onChange={(e) => setProvider(e.target.value as Provider)}
                                    className="w-full p-3 bg-background border border-border rounded-xl text-sm appearance-none cursor-pointer pr-10 text-text-main"
                                >
                                    {providerOptions.map(p => (
                                        <option key={p} value={p}>{PROVIDER_NAMES[p]}</option>
                                    ))}
                                </select>
                                <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                            </div>
                            {!isConnected && (
                                <p className="text-[10px] text-red-500 mt-1">⚠️ No conectado. Añade tu API Key en Ajustes.</p>
                            )}
                        </div>

                        {/* Model Selector */}
                        <div>
                            <label className="block text-xs font-bold text-text-muted uppercase mb-1">Modelo</label>
                            <div className="relative">
                                {isLoadingModels ? (
                                    <div className="w-full p-3 bg-background border border-border rounded-xl text-sm flex items-center gap-2 text-text-muted">
                                        <RefreshCw size={14} className="animate-spin" /> Cargando modelos...
                                    </div>
                                ) : models.length > 0 ? (
                                    <>
                                        <select
                                            value={model}
                                            onChange={(e) => setModel(e.target.value)}
                                            className="w-full p-3 bg-background border border-border rounded-xl text-sm font-mono appearance-none cursor-pointer pr-10 text-text-main truncate"
                                        >
                                            {models.map((m) => (
                                                <option key={m} value={m}>{m}</option>
                                            ))}
                                        </select>
                                        <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                                    </>
                                ) : (
                                    <input
                                        type="text"
                                        value={model}
                                        onChange={(e) => setModel(e.target.value)}
                                        className="w-full p-3 bg-background border border-border rounded-xl text-sm font-mono text-text-main"
                                        placeholder="Escribe el modelo..."
                                    />
                                )}
                            </div>
                        </div>

                        {/* Prompt */}
                        <div>
                            <label className="block text-xs font-bold text-text-muted uppercase mb-1">Prompt</label>
                            <textarea
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                                className="w-full p-3 bg-background border border-border rounded-xl text-sm min-h-[120px] resize-none focus:ring-2 focus:ring-primary/50 text-text-main"
                                placeholder="Describe la imagen con detalle..."
                            />
                        </div>

                        <button
                            onClick={handleGenerate}
                            disabled={isLoading || !prompt.trim() || !model}
                            className={`w-full py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${isLoading || !prompt.trim() || !model
                                ? 'bg-surface-highlight text-text-muted cursor-not-allowed'
                                : 'bg-primary text-white hover:bg-primary-hover shadow-lg hover:shadow-primary/25'
                                }`}
                        >
                            {isLoading ? <Loader2 size={18} className="animate-spin" /> : <ImageIcon size={18} />}
                            {isLoading ? 'Generando...' : 'Generar Imagen'}
                        </button>
                    </div>

                    {/* Right: Preview & Logs */}
                    <div className="flex-1 mt-6 md:mt-0 flex flex-col min-h-[300px]">

                        {/* Preview Area */}
                        <div className="flex-1 bg-black/5 dark:bg-black/40 rounded-xl border border-border flex items-center justify-center relative overflow-hidden group min-h-[300px]">
                            {result.url ? (
                                <>
                                    <img src={result.url} alt="Generated" className="max-w-full max-h-full object-contain shadow-lg" />
                                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3 backdrop-blur-[2px]">
                                        <button
                                            onClick={handleDownload}
                                            className="px-4 py-2 bg-white text-black rounded-full font-bold flex items-center gap-2 hover:scale-105 transition-transform"
                                        >
                                            <Download size={16} /> Guardar
                                        </button>
                                        <button
                                            onClick={() => window.open(result.url || '', '_blank')}
                                            className="px-4 py-2 bg-black/50 text-white border border-white/20 rounded-full font-medium backdrop-blur-md hover:bg-black/70"
                                        >
                                            Ver Original
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <div className="text-center text-text-muted">
                                    {result.error ? (
                                        <div className="p-4 max-w-xs text-red-500 bg-red-50 dark:bg-red-900/10 rounded-xl">
                                            <p className="font-bold mb-1">Error</p>
                                            <p className="text-sm">{result.error}</p>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-center opacity-50">
                                            <Sparkles size={48} className="mb-2" />
                                            <p>Tu creatividad aparecerá aquí</p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Logs Section */}
                        {result.logs && (
                            <div className="mt-4 border border-border rounded-xl overflow-hidden bg-background">
                                <button
                                    onClick={() => setShowLogs(!showLogs)}
                                    className="w-full flex items-center justify-between p-3 bg-surface-highlight/30 hover:bg-surface-highlight transition-colors text-xs font-mono text-text-muted"
                                >
                                    <span className="flex items-center gap-2">
                                        <Terminal size={12} /> Debug JSON Logs
                                    </span>
                                    <ChevronDown size={14} className={`transition-transform ${showLogs ? 'rotate-180' : ''}`} />
                                </button>

                                {showLogs && (
                                    <div className="p-0 overflow-hidden">
                                        <div className="max-h-48 overflow-y-auto p-3 bg-black text-green-400 font-mono text-[10px] leading-tight selection:bg-green-900/50">
                                            <pre>{JSON.stringify(result.logs, null, 2)}</pre>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
