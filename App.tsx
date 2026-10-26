import React, { useState, useEffect, useRef } from 'react';
import { Send, Menu, X, Plus, MessageSquare, Trash2, RefreshCw, Copy, Square, Paperclip, ChevronDown, Upload, Wrench, VenetianMask, EyeOff, FileCode } from 'lucide-react';
import { Share2, FileText, FileJson, Sparkles, BookOpen } from 'lucide-react';
import { storageService } from './services/storageService';
import { sendMessage, fetchModels, completeOnce, getFriendlyLLMError, ToolApprovalRequest } from './services/llmService';
import { connectServer, disconnectServer, getFriendlyMCPError, refreshServerLists, setMCPHooks, MCPProgress } from './services/mcpClient';
import { authorizeServer, openAuthPopup } from './services/mcpOAuth';
import { MCPServerRequestModal, PendingServerRequest } from './components/MCPServerRequestModal';
import { MCPLibraryModal } from './components/MCPLibraryModal';
import { setBridgeToken } from './services/bridge';
import { fileToAttachment, formatBytes, ACCEPT_ATTRIBUTE, exportSessionJSON, exportSessionMarkdown, shareSession, shareText, copyText, shareOutcomeLabel, importSessionsFromFile, sessionToMarkdown } from './services/fileService';
import { GeneratedImage } from './services/imageGenService';
import { ImageGenModal } from './components/ImageGenModal';
import { FileUploadModal } from './components/FileUploadModal';
import { SearchableSelect } from './components/SearchableSelect';
import { AppSettings, ChatSession, Message, Provider, Attachment, MCPServer, PROVIDER_NAMES } from './types';
import { LoginScreen } from './components/LoginScreen';
import { ToolApprovalModal, type ToolDecision } from './components/ToolApprovalModal';
import { ManageModal } from './components/ManageModal';
import { Sidebar } from './components/Sidebar';
import { SettingsModal } from './components/SettingsModal';
import { StorageWarningModal, getStorageUsage } from './components/StorageWarningModal';
import { SystemPromptModal } from './components/SystemPromptModal';
import { DeleteChatModal } from './components/DeleteChatModal';
import { ChatMessage } from './components/ChatMessage';
import { Markdown } from './components/Markdown';
import { AttachmentIcon } from './components/AttachmentIcon';
import { DictationButton } from './components/DictationButton';
import { GalleryModal } from './components/GalleryModal';
import { onImageEditRequest } from './services/imageBus';
import { THEMES, DEFAULT_SETTINGS, INITIAL_SESSION, LOGIN_REQUIRED } from './config/defaults';

// Safe Env Access (supports both REACT_APP_ and VITE_ prefixes)
export default function App() {
    // --- Auth State ---
    const [isAuthenticated, setIsAuthenticated] = useState(() => {
        return !LOGIN_REQUIRED || localStorage.getItem('nexus_auth') === 'true';
    });

    // --- App State ---
    const [settings, setSettings] = useState<AppSettings>(() => {
        const saved = localStorage.getItem('nexus_settings');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                return {
                    ...DEFAULT_SETTINGS, ...parsed,
                    mcpRegistryUrl: parsed.mcpRegistryUrl || DEFAULT_SETTINGS.mcpRegistryUrl,
                    // Un servidor que quedó "loading" al recargar nunca terminaría de conectar
                    mcpServers: Array.isArray(parsed.mcpServers)
                        ? parsed.mcpServers.map((s: MCPServer) => ({
                            ...s,
                            status: s.status === 'loading' ? 'idle' : s.status,
                            // Antes "oauth" era un token pegado a mano: ahora eso es "bearer"
                            authType: s.authType === 'oauth' && !s.oauth ? 'bearer' : s.authType
                        }))
                        : []
                };
            } catch {
                return DEFAULT_SETTINGS;
            }
        }
        return DEFAULT_SETTINGS;
    });

    // NEW Architecture: Load sessions from IndexedDB
    const [sessions, setSessions] = useState<ChatSession[]>([INITIAL_SESSION]);
    const [isStorageReady, setIsStorageReady] = useState(false);

    // Auto-connect providers if key exists in env/settings but marked disconnected
    useEffect(() => {
        setSettings(prev => {
            const updates: Partial<AppSettings> = {};
            let changed = false;

            // Helper to auto-connect if key exists and not connected
            const check = (keyProp: keyof AppSettings, connProp: keyof AppSettings) => {
                if (prev[keyProp] && !prev[connProp]) {
                    // Use type assertion to avoid TS errors with string|boolean
                    (updates as any)[connProp] = true;
                    changed = true;
                }
            };

            check('geminiKey', 'geminiConnected');
            check('openaiKey', 'openaiConnected');
            check('anthropicKey', 'anthropicConnected');
            check('groqKey', 'groqConnected');
            check('openRouterKey', 'openRouterConnected');
            check('cerebrasKey', 'cerebrasConnected');
            check('xaiKey', 'xaiConnected');
            check('chatgptKey', 'chatgptConnected');
            // Check custom providers if keys exist
            if (prev.custom1Key && prev.custom1Url) check('custom1Key', 'custom1Connected');
            if (prev.custom2Key && prev.custom2Url) check('custom2Key', 'custom2Connected');

            return changed ? { ...prev, ...updates } : prev;
        });
    }, []); // Run once on mount


    // Ensure activeProvider is actually connected
    useEffect(() => {
        const connectedMap: Record<Provider, keyof AppSettings> = {
            groq: 'groqConnected', openrouter: 'openRouterConnected', openai: 'openaiConnected', anthropic: 'anthropicConnected',
            cerebras: 'cerebrasConnected', gemini: 'geminiConnected', xai: 'xaiConnected',
            custom1: 'custom1Connected', custom2: 'custom2Connected', chatgpt: 'chatgptConnected'
        };

        const isCurrentConnected = settings[connectedMap[settings.activeProvider]];
        if (!isCurrentConnected) {
            // Find first connected provider
            const providers: Provider[] = ['groq', 'openrouter', 'openai', 'anthropic', 'cerebras', 'gemini', 'xai', 'custom1', 'custom2', 'chatgpt'];
            const firstConnected = providers.find(p => settings[connectedMap[p]]);

            if (firstConnected) {
                setSettings(s => ({ ...s, activeProvider: firstConnected }));
            }
        }
        // Sólo cuando cambia qué proveedores están conectados (no en cada cambio de ajustes)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings.groqConnected, settings.openRouterConnected, settings.openaiConnected, settings.anthropicConnected, settings.cerebrasConnected, settings.geminiConnected, settings.xaiConnected, settings.custom1Connected, settings.custom2Connected, settings.chatgptConnected, settings.activeProvider]);

    // Token compartido con /api/mcp y /api/chatgpt
    useEffect(() => { setBridgeToken(settings.proxyToken); }, [settings.proxyToken]);

    useEffect(() => {
        const initStorage = async () => {
            try {
                await storageService.migrateFromLocalStorage();
                const loaded = await storageService.loadAllSessions();
                if (loaded.length > 0) {
                    setSessions(loaded);
                    setCurrentSessionId(loaded[0].id);
                }
            } catch (err) {
                console.error("Critical: Storage initialization failed", err);
                alert("Hubo un problema al cargar tus conversaciones. Por favor, recarga la página.");
            } finally {
                setIsStorageReady(true);
                updateStorageStats();
            }
        };
        initStorage();
    }, []);

    const updateStorageStats = async () => {
        const stats = await getStorageUsage();
        setStorageUsage(stats);
    };

    const [currentSessionId, setCurrentSessionId] = useState<string>(sessions[0].id);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    // UI State
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isManageModalOpen, setIsManageModalOpen] = useState(false);
    const [isImageModalOpen, setIsImageModalOpen] = useState(false);
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [showStorageWarning, setShowStorageWarning] = useState(false);
    const [storageUsage, setStorageUsage] = useState({ used: 0, formatted: 'Calculando...' });
    const [chatToDelete, setChatToDelete] = useState<{ id: string, title: string } | null>(null);

    // Tool Approval State
    const [pendingTool, setPendingTool] = useState<(ToolApprovalRequest & { resolve: (v: boolean) => void }) | null>(null);
    const autoApprovedTools = useRef<Set<string>>(new Set());   // "Permitir siempre" (hasta recargar)
    const abortRef = useRef<AbortController | null>(null);
    const mcpConnecting = useRef(new Map<string, AbortController>());
    const listRefreshTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const settingsRef = useRef(settings);
    settingsRef.current = settings;
    const [serverRequest, setServerRequest] = useState<PendingServerRequest | null>(null);
    const [isMCPLibraryOpen, setIsMCPLibraryOpen] = useState(false);
    const [toolProgress, setToolProgress] = useState<{ tool: string; progress: MCPProgress } | null>(null);
    /** Respuesta que el modelo está escribiendo (streaming) */
    const [streamText, setStreamText] = useState<string | null>(null);
    const [processingFiles, setProcessingFiles] = useState(0);
    const [isGalleryOpen, setIsGalleryOpen] = useState(false);
    // Escape cierra la ventana de arriba (las de aprobación y las del servidor MCP se responden con un botón)
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            const closers: [boolean, () => void][] = [
                [isImageModalOpen, () => { setIsImageModalOpen(false); setImageEditSource(null); }],
                [isGalleryOpen, () => setIsGalleryOpen(false)],
                [isMCPLibraryOpen, () => setIsMCPLibraryOpen(false)],
                [showFileUploadModal, () => setShowFileUploadModal(false)],
                [isSystemPromptOpen, () => setIsSystemPromptOpen(false)],
                [isManageModalOpen, () => setIsManageModalOpen(false)],
                [isSettingsOpen, () => setIsSettingsOpen(false)],
                [isSidebarOpen, () => setIsSidebarOpen(false)]
            ];
            closers.find(([open]) => open)?.[1]();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });
    /** Imagen con la que se abre el generador desde "Editar" */
    const [imageEditSource, setImageEditSource] = useState<string | null>(null);
    useEffect(() => onImageEditRequest((src) => { setImageEditSource(src); setIsImageModalOpen(true); }), []);

    // Lo que los servidores MCP pueden pedirle o avisarle a la app
    useEffect(() => {
        setMCPHooks({
            onServerUpdate: (id, patch) => setSettings(s => ({ ...s, mcpServers: s.mcpServers.map(x => x.id === id ? { ...x, ...patch } : x) })),
            onServerRequest: (server, method, params) =>
                new Promise((resolve, reject) => setServerRequest({ server, method, params, resolve, reject })),
            onNotification: (server, method) => {
                if (!/^notifications\/(tools|resources|prompts)\/list_changed$/.test(method)) return;
                // Los avisos suelen venir en ráfaga: se agrupan y se recarga una sola vez
                clearTimeout(listRefreshTimers.current.get(server.id));
                listRefreshTimers.current.set(server.id, setTimeout(() => refreshServerLists(server).then(lists => lists && setSettings(s => ({
                    ...s,
                    mcpServers: s.mcpServers.map(x => {
                        if (x.id !== server.id) return x;
                        const names = lists.tools.map(t => t.name);
                        const known = x.tools.map(t => t.name);
                        // Las herramientas nuevas quedan activadas; las que desaparecen, fuera
                        return { ...x, ...lists, enabledTools: [...x.enabledTools.filter(n => names.includes(n)), ...names.filter(n => !known.includes(n))] };
                    })
                }))).catch(() => { }), 800));
            }
        });
    }, []);

    /** sampling/createMessage: el servidor pide una respuesta de NUESTRO modelo. */
    const runSampling = async (params: any) => {
        const toParts = (c: any): any[] => c?.type === 'image'
            ? [{ type: 'image_url', image_url: { url: `data:${c.mimeType};base64,${c.data}` } }]
            : c?.type === 'text' ? [{ type: 'text', text: c.text }] : [];
        const messages = (params?.messages || []).map((m: any) => {
            const parts = (Array.isArray(m.content) ? m.content : [m.content]).flatMap(toParts);
            const onlyText = parts.every((p: any) => p.type === 'text');
            return {
                role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
                content: onlyText ? parts.map((p: any) => p.text).join('\n') : parts
            };
        });
        const current = settingsRef.current;
        const { text, model } = await completeOnce(current, messages, {
            systemPrompt: params?.systemPrompt,
            onSettingsPatch: (patch) => setSettings(s => ({ ...s, ...patch }))
        });
        return { role: 'assistant', content: { type: 'text', text }, model: `${current.activeProvider}/${model}`, stopReason: 'endTurn' };
    };

    // Sharing / drag & drop
    const [isDragging, setIsDragging] = useState(false);
    const [showShareMenu, setShowShareMenu] = useState(false);
    const [toast, setToast] = useState('');
    const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 2500); };

    // Connection Loading States
    const [isConnectingGroq, setIsConnectingGroq] = useState(false);
    const [isConnectingOpenRouter, setIsConnectingOpenRouter] = useState(false);

    const [isSystemPromptOpen, setIsSystemPromptOpen] = useState(false);

    // Models Manager Modal State
    const [showModelsManager, setShowModelsManager] = useState(false);
    const [showFileUploadModal, setShowFileUploadModal] = useState(false);
    const [modelsManagerProvider, setModelsManagerProvider] = useState<Provider>('gemini');
    const [newModelName, setNewModelName] = useState('');

    const messagesEndRef = useRef<HTMLDivElement>(null);

    // --- Derived State ---
    const currentSession = sessions.find(s => s.id === currentSessionId) || sessions[0];
    const hasMCPLibrary = settings.mcpServers.some(s => s.status === 'connected' && ((s.prompts?.length || 0) + (s.resources?.length || 0) + (s.resourceTemplates?.length || 0)) > 0);

    // --- Effects ---

    useEffect(() => {
        const root = document.documentElement;
        const themeConfig = THEMES[settings.theme];

        if (settings.darkMode) {
            root.classList.add('dark');
        } else {
            root.classList.remove('dark');
        }

        const vars: Record<string, string> = {
            '--color-primary': themeConfig.primary,
            '--color-primary-hover': themeConfig.primaryHover,
            '--color-primary-light': settings.darkMode ? `${themeConfig.primary}30` : themeConfig.primaryLight,
            '--color-background': settings.darkMode ? '#0f172a' : '#f8fafc',
            '--color-surface': settings.darkMode ? '#1e293b' : '#ffffff',
            '--color-surface-highlight': settings.darkMode ? '#334155' : '#f1f5f9',
            '--color-text-main': settings.darkMode ? '#f8fafc' : '#0f172a',
            '--color-text-muted': settings.darkMode ? '#94a3b8' : '#64748b',
            '--color-text-inverted': settings.darkMode ? '#0f172a' : '#ffffff',
            '--color-border': settings.darkMode ? '#334155' : '#e2e8f0',
        };

        Object.entries(vars).forEach(([key, val]) => {
            root.style.setProperty(key, val);
        });

    }, [settings.theme, settings.darkMode]);

    useEffect(() => {
        if (!settings.incognitoMode) {
            localStorage.setItem('nexus_settings', JSON.stringify(settings));
        }
    }, [settings]);

    useEffect(() => {
        if (!settings.incognitoMode && isStorageReady) {
            const saveCurrent = async () => {
                const current = sessions.find(s => s.id === currentSessionId);
                if (current) {
                    await storageService.saveSession(current);
                    updateStorageStats();
                }
            };
            saveCurrent();
        }
    }, [sessions, currentSessionId, settings.incognitoMode, isStorageReady]);

    useEffect(() => {
        const end = messagesEndRef.current;
        const box = end?.parentElement;
        if (!end || !box) return;
        // Mientras llega texto, seguir abajo sólo si el usuario no subió a leer
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
        if (!streamText || nearBottom) end.scrollIntoView({ behavior: streamText ? 'auto' : 'smooth' });
    }, [currentSession.messages, streamText]);

    // --- Handlers ---
    const handleBackupSessions = () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(sessions, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "nexus_backup_" + new Date().toISOString().replace(/[:.]/g, '-') + ".json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    };

    const handleStorageCleanup = async () => {
        // Keep last 20 messages of current session
        const current = sessions.find(s => s.id === currentSessionId);
        if (current && current.messages.length > 20) {
            const truncatedMessages = current.messages.slice(-20);
            const updatedSession = { ...current, messages: truncatedMessages };

            setSessions(prev => prev.map(s => s.id === currentSessionId ? updatedSession : s));

            // Explicit save to IDB
            await storageService.saveSession(updatedSession);
            setShowStorageWarning(false);
            updateStorageStats();
            alert('Limpieza completada. Se ha reducido el tamaño de este chat.');
        }
    };

    const handleLogin = () => {
        setIsAuthenticated(true);
        localStorage.setItem('nexus_auth', 'true');
    };

    const handleLogout = () => {
        setIsAuthenticated(false);
        localStorage.removeItem('nexus_auth');
    };

    const handleNewChat = () => {
        const newSession: ChatSession = {
            id: Date.now().toString(),
            title: 'Nuevo Chat',
            messages: [],
            createdAt: Date.now()
        };
        setSessions(prev => [newSession, ...prev]);
        setCurrentSessionId(newSession.id);
    };

    const handleDeleteChat = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const chat = sessions.find(s => s.id === id);
        if (chat) {
            setChatToDelete({ id: chat.id, title: chat.title });
        }
    };

    const handleExportSingleChat = async (customName?: string) => {
        if (!chatToDelete) return;
        const chat = sessions.find(s => s.id === chatToDelete.id);
        if (!chat) return;

        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(chat, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);

        let filename = `nexus_chat_${chat.id}_${new Date().toISOString().slice(0, 10)}.json`;
        if (customName && typeof customName === 'string' && customName.trim()) {
            filename = customName.endsWith('.json') ? customName : `${customName}.json`;
        }

        downloadAnchorNode.setAttribute("download", filename);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();

        // After export, also delete the chat
        await confirmDeleteChat();
    };

    const handleDownloadOnlyChat = (customName?: string) => {
        if (!chatToDelete) return;
        const chat = sessions.find(s => s.id === chatToDelete.id);
        if (!chat) return;

        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(chat, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);

        let filename = `nexus_chat_${chat.id}_${new Date().toISOString().slice(0, 10)}.json`;
        if (customName && typeof customName === 'string' && customName.trim()) {
            filename = customName.endsWith('.json') ? customName : `${customName}.json`;
        }

        downloadAnchorNode.setAttribute("download", filename);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        // Note: Does NOT delete the chat
    };

    const confirmDeleteChat = async () => {
        if (!chatToDelete) return;
        const id = chatToDelete.id;

        // 1. Remove from IDB
        await storageService.deleteSession(id);

        const newSessions = sessions.filter(s => s.id !== id);
        if (newSessions.length === 0) {
            const newSession = { ...INITIAL_SESSION, id: Date.now().toString() };
            setSessions([newSession]);
            setCurrentSessionId(newSession.id);
            await storageService.saveSession(newSession);
        } else {
            setSessions(newSessions);
            if (currentSessionId === id) {
                setCurrentSessionId(newSessions[0].id);
            }
        }

        setChatToDelete(null);
        updateStorageStats();
    };

    const handleDeleteAll = async () => {
        if (confirm('ADVERTENCIA: ¿Estás seguro de que quieres borrar ABSOLUTAMENTE TODO el historial?')) {
            await storageService.clearAll();

            const newSession = { ...INITIAL_SESSION, id: Date.now().toString() };
            setSessions([newSession]);
            setCurrentSessionId(newSession.id);
            await storageService.saveSession(newSession);

            setIsManageModalOpen(false);
            updateStorageStats();
        }
    };

    const handleExportChats = (customName?: string) => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(sessions, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);

        let filename = `nexus_chats_${new Date().toISOString().slice(0, 10)}.json`;
        if (customName && typeof customName === 'string' && customName.trim()) {
            filename = customName.endsWith('.json') ? customName : `${customName}.json`;
        }

        downloadAnchorNode.setAttribute("download", filename);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        setIsManageModalOpen(false);
    };

    const connectProvider = async (provider: Provider) => {
        // Dynamic key mapping for all providers
        const keyMap: Record<Provider, keyof AppSettings> = {
            groq: 'groqKey', openrouter: 'openRouterKey', openai: 'openaiKey', anthropic: 'anthropicKey',
            cerebras: 'cerebrasKey', gemini: 'geminiKey', xai: 'xaiKey',
            custom1: 'custom1Key', custom2: 'custom2Key', chatgpt: 'chatgptKey'
        };
        const connectedMap: Record<Provider, keyof AppSettings> = {
            groq: 'groqConnected', openrouter: 'openRouterConnected', openai: 'openaiConnected', anthropic: 'anthropicConnected',
            cerebras: 'cerebrasConnected', gemini: 'geminiConnected', xai: 'xaiConnected',
            custom1: 'custom1Connected', custom2: 'custom2Connected', chatgpt: 'chatgptConnected'
        };
        const modelsListMap: Record<Provider, keyof AppSettings> = {
            groq: 'groqModelsList', openrouter: 'openRouterModelsList', openai: 'openaiModelsList', anthropic: 'anthropicModelsList',
            cerebras: 'cerebrasModelsList', gemini: 'geminiModelsList', xai: 'xaiModelsList',
            custom1: 'custom1ModelsList', custom2: 'custom2ModelsList', chatgpt: 'chatgptModelsList'
        };
        const modelMap: Record<Provider, keyof AppSettings> = {
            groq: 'groqModel', openrouter: 'openRouterModel', openai: 'openaiModel', anthropic: 'anthropicModel',
            cerebras: 'cerebrasModel', gemini: 'geminiModel', xai: 'xaiModel',
            custom1: 'custom1Model', custom2: 'custom2Model', chatgpt: 'chatgptModel'
        };

        const key = settings[keyMap[provider]] as string;
        if (!key) return;

        // Set loading state (simplified - just use a generic flag or skip)
        if (provider === 'groq') setIsConnectingGroq(true);
        else if (provider === 'openrouter') setIsConnectingOpenRouter(true);

        // For custom providers, we need to pass the custom URL
        let customUrl: string | undefined = undefined;
        if (provider === 'custom1') customUrl = settings.custom1Url;
        if (provider === 'custom2') customUrl = settings.custom2Url;

        const models = await fetchModels(provider, key, customUrl);

        if (models.length > 0) {
            setSettings(prev => ({
                ...prev,
                [connectedMap[provider]]: true,
                [modelsListMap[provider]]: models,
                [modelMap[provider]]: models.includes(prev[modelMap[provider]] as string) ? prev[modelMap[provider]] : models[0]
            }));
        } else {
            alert('Error de conexión: No se pudieron obtener los modelos. Verifica tu API Key.');
            setSettings(prev => ({ ...prev, [connectedMap[provider]]: false }));
        }

        if (provider === 'groq') setIsConnectingGroq(false);
        else if (provider === 'openrouter') setIsConnectingOpenRouter(false);
    };

    const disconnectProvider = (provider: Provider) => {
        const connectedMap: Record<Provider, keyof AppSettings> = {
            groq: 'groqConnected', openrouter: 'openRouterConnected', openai: 'openaiConnected', anthropic: 'anthropicConnected',
            cerebras: 'cerebrasConnected', gemini: 'geminiConnected', xai: 'xaiConnected',
            custom1: 'custom1Connected', custom2: 'custom2Connected', chatgpt: 'chatgptConnected'
        };
        setSettings(prev => ({ ...prev, [connectedMap[provider]]: false }));
    };

    // --- MCP Handlers (Multi-Server) ---

    const addMCPServer = () => {
        const newServer: MCPServer = {
            id: Date.now().toString(),
            url: 'https://TU-INSTANCIA.app.n8n.cloud/mcp/...',
            transport: 'auto',
            useProxy: true,
            authType: 'none',
            authToken: '',
            status: 'idle',
            errorMessage: '',
            tools: [],
            enabledTools: []
        };
        setSettings(s => ({ ...s, mcpServers: [...s.mcpServers, newServer] }));
    };

    const removeMCPServer = (serverId: string) => {
        disconnectServer(serverId);
        setSettings(s => ({ ...s, mcpServers: s.mcpServers.filter(srv => srv.id !== serverId) }));
    };

    const updateMCPServer = (serverId: string, patch: Partial<MCPServer>) =>
        setSettings(s => ({ ...s, mcpServers: s.mcpServers.map(srv => srv.id === serverId ? { ...srv, ...patch } : srv) }));

    /**
     * Conecta un servidor MCP. Con `authorize`, antes corre el flujo OAuth: la
     * ventana se abre ACÁ, sin ningún await antes, o el navegador la bloquea.
     */
    const connectMCPServer = async (serverId: string, opts: { authorize?: boolean } = {}) => {
        const popup = opts.authorize ? openAuthPopup() : null;
        const server = settingsRef.current.mcpServers.find(s => s.id === serverId);
        if (!server) { popup?.close(); return; }

        const controller = new AbortController();
        mcpConnecting.current.get(serverId)?.abort();
        mcpConnecting.current.set(serverId, controller);
        const logLines: string[] = [];
        const log = (line: string) => { logLines.push(line); updateMCPServer(serverId, { connectionLog: [...logLines] }); };
        updateMCPServer(serverId, { status: 'loading', errorMessage: '', connectionLog: [] });

        let target: MCPServer = { ...server, url: server.url.trim() };
        try {
            if (opts.authorize) {
                const oauth = await authorizeServer(target, popup, {}, log, controller.signal);
                target = { ...target, oauth };
                updateMCPServer(serverId, { oauth });
            }
            // Handshake completo: initialize -> notifications/initialized -> tools/list (+ recursos y prompts)
            const res = await connectServer(target, controller.signal, log);
            const toolNames = res.tools.map(t => t.name);
            setSettings(s => ({
                ...s,
                mcpServers: s.mcpServers.map(srv => srv.id === serverId ? {
                    ...srv,
                    status: 'connected',
                    tools: res.tools,
                    resources: res.resources,
                    resourceTemplates: res.resourceTemplates,
                    prompts: res.prompts,
                    serverInfo: res.serverInfo,
                    protocolVersion: res.protocolVersion,
                    resolvedTransport: res.resolvedTransport,
                    era: res.era,
                    instructions: res.instructions,
                    capabilities: res.capabilities,
                    // Conservar la selección previa si las herramientas siguen existiendo
                    enabledTools: srv.enabledTools.filter(n => toolNames.includes(n)).length > 0
                        ? srv.enabledTools.filter(n => toolNames.includes(n))
                        : toolNames
                } : srv)
            }));
        } catch (e: any) {
            if (controller.signal.aborted) {
                updateMCPServer(serverId, { status: 'idle' });
                return;
            }
            updateMCPServer(serverId, { status: 'error', errorMessage: getFriendlyMCPError(e) });
        } finally {
            if (mcpConnecting.current.get(serverId) === controller) mcpConnecting.current.delete(serverId);
        }
    };

    const cancelMCPServer = (serverId: string) => {
        mcpConnecting.current.get(serverId)?.abort();
        disconnectServer(serverId);
        updateMCPServer(serverId, { status: 'idle' });
    };

    const disconnectMCPServer = (serverId: string) => {
        disconnectServer(serverId);
        setSettings(s => ({
            ...s,
            mcpServers: s.mcpServers.map(srv => srv.id === serverId ? {
                ...srv,
                status: 'idle',
                tools: [],
                enabledTools: []
            } : srv)
        }));
    };

    const toggleMCPTool = (serverId: string, toolName: string) => {
        setSettings(s => ({
            ...s,
            mcpServers: s.mcpServers.map(srv => {
                if (srv.id !== serverId) return srv;
                const isEnabled = srv.enabledTools.includes(toolName);
                return {
                    ...srv,
                    enabledTools: isEnabled
                        ? srv.enabledTools.filter(n => n !== toolName)
                        : [...srv.enabledTools, toolName]
                };
            })
        }));
    };

    // --- Adjuntos: input, drag & drop y pegar desde el portapapeles ---
    const addFiles = async (files: File[]) => {
        setShowFileUploadModal(false);
        const errors: string[] = [];
        // Leer, extraer texto o transcribir puede tardar: se muestra cuántos faltan
        setProcessingFiles(n => n + files.length);
        await Promise.all(files.map(async (file) => {
            try {
                const att = await fileToAttachment(file, { settings: settingsRef.current });
                setAttachments(prev => [...prev, att]);
            } catch (err: any) {
                errors.push(err.message || `Error leyendo ${file.name}`);
            } finally {
                setProcessingFiles(n => n - 1);
            }
        }));
        if (errors.length > 0) flash(errors.join(' · '));
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files ? Array.from(e.target.files) : [];
        if (e.target) e.target.value = '';
        if (files.length) await addFiles(files);
    };

    const handlePaste = (e: React.ClipboardEvent) => {
        const files = Array.from(e.clipboardData.files);
        if (files.length > 0) {
            e.preventDefault();
            addFiles(files);
        }
    };

    // --- Tool Approval Logic ---

    const handleToolApproval = async (req: ToolApprovalRequest): Promise<boolean> => {
        if (autoApprovedTools.current.has(`${req.serverName}::${req.originalName}`)) return true;
        return new Promise<boolean>((resolve) => {
            setPendingTool({ ...req, resolve });
        });
    };

    const confirmTool = (decision: ToolDecision) => {
        if (pendingTool) {
            if (decision === 'always') autoApprovedTools.current.add(`${pendingTool.serverName}::${pendingTool.originalName}`);
            pendingTool.resolve(decision !== 'deny');
            setPendingTool(null);
        }
    };

    const handleStop = () => {
        abortRef.current?.abort();
        // Si estaba esperando aprobación, liberar la promesa
        if (pendingTool) {
            pendingTool.resolve(false);
            setPendingTool(null);
        }
    };

    /** ¿Hay un proveedor conectado? Si no, abre Ajustes. */
    const ensureConnected = () => {
        const connectedMap: Record<Provider, keyof AppSettings> = {
            groq: 'groqConnected', openrouter: 'openRouterConnected', openai: 'openaiConnected', anthropic: 'anthropicConnected',
            cerebras: 'cerebrasConnected', gemini: 'geminiConnected', xai: 'xaiConnected',
            custom1: 'custom1Connected', custom2: 'custom2Connected', chatgpt: 'chatgptConnected'
        };
        if (settings[connectedMap[settings.activeProvider]]) return true;
        flash(`Conecta ${PROVIDER_NAMES[settings.activeProvider]} en Ajustes primero.`);
        setIsSettingsOpen(true);
        return false;
    };

    /** Vuelve a pedir la última respuesta (desde el último mensaje del usuario). */
    const handleRegenerate = () => {
        if (isLoading || !ensureConnected()) return;
        const msgs = currentSession.messages;
        const lastUser = msgs.map(m => m.role).lastIndexOf('user');
        if (lastUser >= 0) sendConversation(msgs.slice(0, lastUser + 1));
    };

    /** Editar un mensaje propio: vuelve al cuadro de texto y la conversación se corta ahí. */
    const handleEditMessage = (msg: Message) => {
        if (isLoading) return;
        const idx = currentSession.messages.findIndex(m => m.id === msg.id);
        if (idx < 0) return;
        setInput(msg.content || '');
        setAttachments(msg.attachments || []);
        setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, messages: s.messages.slice(0, idx) } : s));
    };

    const handleSend = async () => {
        if ((!input.trim() && attachments.length === 0) || isLoading || processingFiles > 0) return;

        if (!ensureConnected()) return;

        const userMsg: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: input,
            timestamp: Date.now(),
            attachments: attachments.length ? [...attachments] : undefined
        };
        const title = currentSession.messages.length === 0 ? (input.slice(0, 30) || attachments[0]?.name || 'Archivo adjunto') : undefined;
        setInput('');
        setAttachments([]);
        await sendConversation([...currentSession.messages, userMsg], title);
    };

    /** Envía un historial (que termina en un mensaje del usuario) y agrega lo que responda el modelo. */
    const sendConversation = async (updatedMessages: Message[], title?: string) => {
        const sessionId = currentSessionId;
        setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, messages: updatedMessages, ...(title ? { title } : {}) } : s));
        setIsLoading(true);

        const controller = new AbortController();
        abortRef.current = controller;
        const showMessages = (extra: Message[]) => setSessions(prev => prev.map(s =>
            s.id === sessionId ? { ...s, messages: [...updatedMessages, ...extra] } : s
        ));

        // Progreso parcial: si el usuario cancela, conservamos lo ya ejecutado
        let partial: Message[] = [];

        try {
            // El historial ya incluye el mensaje del usuario (antes se enviaba dos veces)
            const newMessages = await sendMessage(settings, updatedMessages, {
                onToolApproval: handleToolApproval,
                onUpdate: (msgs) => { partial = msgs; showMessages(msgs); },
                onSettingsPatch: (patch) => setSettings(s => ({ ...s, ...patch })),
                sessionId,
                signal: controller.signal,
                onToolProgress: (tool, progress) => setToolProgress(progress ? { tool, progress } : null),
                onStream: (text) => setStreamText(text)
            });
            showMessages(newMessages);
        } catch (error: any) {
            const cancelled = error?.name === 'AbortError' || controller.signal.aborted;
            const errorMsg: Message = {
                id: (Date.now() + 1).toString(),
                role: 'system',
                content: cancelled
                    ? '⏹️ Generación detenida por el usuario.'
                    : getFriendlyLLMError(error?.message, PROVIDER_NAMES[settings.activeProvider] || settings.activeProvider),
                timestamp: Date.now()
            };
            showMessages([...partial, errorMsg]);
        } finally {
            abortRef.current = null;
            setIsLoading(false);
            setToolProgress(null);
            setStreamText(null);
        }
    };

    // --- Imágenes generadas -> chat ---
    const handleInsertGeneratedImages = (images: GeneratedImage[], prompt: string, meta: { provider: Provider; model: string; logs: any }) => {
        const now = Date.now();
        const userMsg: Message = { id: `${now}`, role: 'user', content: `🖼️ ${prompt}`, timestamp: now };
        const modelMsg: Message = {
            id: `${now + 1}`,
            role: 'model',
            content: `Imagen generada con **${meta.model}** (${PROVIDER_NAMES[meta.provider] || meta.provider}).`,
            attachments: images.map((img, i) => ({ name: `imagen-${i + 1}.${img.mimeType.split('/')[1] || 'png'}`, type: img.mimeType, data: img.url })),
            timestamp: now + 1,
            rawDebug: { requestId: `img-${now}`, provider: meta.provider, model: meta.model, requestPayload: meta.logs?.request, responsePayload: meta.logs?.response }
        };
        setSessions(prev => prev.map(s => s.id === currentSessionId ? {
            ...s,
            title: s.messages.length === 0 ? `🖼️ ${prompt.slice(0, 28)}` : s.title,
            messages: [...s.messages, userMsg, modelMsg]
        } : s));
    };

    // --- Compartir / exportar ---
    const handleImportChats = async (file: File) => {
        try {
            const imported = await importSessionsFromFile(file);
            setSessions(prev => [...imported, ...prev]);
            setCurrentSessionId(imported[0].id);
            if (!settings.incognitoMode) {
                for (const s of imported) await storageService.saveSession(s);
            }
            setIsManageModalOpen(false);
            flash(`${imported.length} conversación(es) importada(s)`);
        } catch (e: any) {
            alert(e.message);
        }
    };

    const handleImportConfig = async (imported: Partial<AppSettings>, importedSessions: ChatSession[]) => {
        // Las conexiones MCP vivas no se pueden restaurar: se reconectan desde Ajustes
        settings.mcpServers.forEach(s => disconnectServer(s.id));
        setSettings(prev => ({ ...prev, ...imported }));
        if (importedSessions.length > 0) {
            setSessions(prev => [...importedSessions, ...prev]);
            setCurrentSessionId(importedSessions[0].id);
            if (!settings.incognitoMode) {
                for (const s of importedSessions) await storageService.saveSession(s);
            }
        }
    };

    const handleShareMessage = async (msg: Message) => {
        const outcome = await shareText(msg.content || '', currentSession.title);
        if (outcome !== 'shared' && outcome !== 'cancelled') flash(shareOutcomeLabel[outcome]);
    };



    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    if (!isStorageReady) {
        return (
            <div className="h-screen w-full flex items-center justify-center bg-background text-text-main flex-col gap-4">
                <RefreshCw className="animate-spin text-primary" size={48} />
                <h2 className="text-xl font-bold">Cargando Conversaciones...</h2>
                <p className="text-text-muted">Optimizando base de datos</p>
            </div>
        );
    }

    if (!isAuthenticated) {
        return <LoginScreen onLogin={handleLogin} />;
    }

    return (
        <div className="flex h-screen w-full bg-background transition-colors duration-300">
            <Sidebar
                isOpen={isSidebarOpen}
                onClose={() => setIsSidebarOpen(false)}
                sessions={sessions}
                currentSessionId={currentSessionId}
                setCurrentSessionId={setCurrentSessionId}
                handleNewChat={handleNewChat}
                handleDeleteChat={handleDeleteChat}
                settings={settings}
                setSettings={setSettings}
                setIsSettingsOpen={setIsSettingsOpen}
                setIsManageModalOpen={setIsManageModalOpen}
                setIsImageModalOpen={setIsImageModalOpen}
                setIsGalleryOpen={setIsGalleryOpen}
                onLogout={handleLogout}
            />

            <SystemPromptModal
                isOpen={isSystemPromptOpen}
                onClose={() => setIsSystemPromptOpen(false)}
                prompt={settings.systemPrompt}
                onChange={(val: string) => setSettings((s: AppSettings) => ({ ...s, systemPrompt: val }))}
            />
            <MCPServerRequestModal request={serverRequest} runSampling={runSampling} onDone={() => setServerRequest(null)} />

            <MCPLibraryModal
                isOpen={isMCPLibraryOpen}
                onClose={() => setIsMCPLibraryOpen(false)}
                servers={settings.mcpServers}
                onInsert={(text, atts) => {
                    if (text) setInput(prev => prev ? `${prev}\n\n${text}` : text);
                    if (atts.length) setAttachments(prev => [...prev, ...atts]);
                }}
            />

            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
                settings={settings}
                setSettings={setSettings}
                connectProvider={connectProvider}
                disconnectProvider={disconnectProvider}
                isConnectingGroq={isConnectingGroq}
                isConnectingOpenRouter={isConnectingOpenRouter}
                addMCPServer={addMCPServer}
                removeMCPServer={removeMCPServer}
                connectMCPServer={connectMCPServer}
                disconnectMCPServer={disconnectMCPServer}
                toggleMCPTool={toggleMCPTool}
                updateMCPServer={updateMCPServer}
                cancelMCPServer={cancelMCPServer}
                openModelsManager={(provider: Provider) => { setModelsManagerProvider(provider); setShowModelsManager(true); }}
            />

            <ManageModal
                isOpen={isManageModalOpen}
                onClose={() => setIsManageModalOpen(false)}
                onExport={handleExportChats}
                onImport={handleImportChats}
                onDeleteAll={handleDeleteAll}
                storageUsage={storageUsage}
                settings={settings}
                sessions={sessions}
                onImportConfig={handleImportConfig}
            />

            <ImageGenModal
                isOpen={isImageModalOpen}
                onClose={() => { setIsImageModalOpen(false); setImageEditSource(null); }}
                settings={settings}
                onInsertInChat={handleInsertGeneratedImages}
                onAttach={(atts) => setAttachments(prev => [...prev, ...atts])}
                initialReference={imageEditSource}
                onSettingsChange={(patch) => setSettings(s => ({ ...s, ...patch }))}
            />

            <GalleryModal
                isOpen={isGalleryOpen}
                onClose={() => setIsGalleryOpen(false)}
                sessions={sessions}
                onOpenChat={(id) => setCurrentSessionId(id)}
                onAttach={(att) => setAttachments(prev => [...prev, att])}
            />


            <ToolApprovalModal
                pendingTool={pendingTool}
                onConfirm={confirmTool}
            />

            <StorageWarningModal
                isOpen={showStorageWarning}
                onClose={() => setShowStorageWarning(false)}
                onBackup={handleBackupSessions}
                onCleanup={handleStorageCleanup}
            />

            <DeleteChatModal
                isOpen={!!chatToDelete}
                onClose={() => setChatToDelete(null)}
                onConfirm={confirmDeleteChat}
                onExport={handleExportSingleChat}
                onDownloadOnly={handleDownloadOnlyChat}
                chatTitle={chatToDelete?.title || ''}
            />

            {/* Models Manager Modal */}
            {showModelsManager && modelsManagerProvider && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm p-4">
                    <div className="bg-surface rounded-2xl p-6 w-full max-w-md max-h-[80vh] overflow-y-auto shadow-xl border border-border animate-in fade-in zoom-in-95">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-lg font-bold text-text-main flex items-center gap-2">
                                <Wrench size={20} /> Gestionar Modelos
                            </h2>
                            <button onClick={() => { setShowModelsManager(false); setNewModelName(''); }} className="text-text-muted hover:text-text-main">
                                <X size={20} />
                            </button>
                        </div>

                        <p className="text-sm text-text-muted mb-4">
                            Proveedor: <strong className="text-text-main capitalize">{modelsManagerProvider}</strong>
                        </p>

                        {/* Current Models List */}
                        <div className="space-y-2 mb-4">
                            <label className="block text-xs font-semibold text-text-muted uppercase">Modelos disponibles</label>
                            {(() => {
                                const modelsListMap: Record<Provider, keyof AppSettings> = {
                                    groq: 'groqModelsList', openrouter: 'openRouterModelsList', openai: 'openaiModelsList', anthropic: 'anthropicModelsList',
                                    cerebras: 'cerebrasModelsList', gemini: 'geminiModelsList', xai: 'xaiModelsList',
                                    custom1: 'custom1ModelsList', custom2: 'custom2ModelsList', chatgpt: 'chatgptModelsList'
                                };
                                const models = settings[modelsListMap[modelsManagerProvider]] as string[];
                                return (
                                    <div className="max-h-48 overflow-y-auto space-y-1">
                                        {models.map((model, idx) => (
                                            <div key={idx} className="flex items-center justify-between p-2 bg-background rounded-lg border border-border">
                                                <span className="text-sm text-text-main truncate flex-1">{model}</span>
                                                <button
                                                    onClick={() => {
                                                        const newList = models.filter((_, i) => i !== idx);
                                                        setSettings(prev => ({ ...prev, [modelsListMap[modelsManagerProvider]]: newList }));
                                                    }}
                                                    className="text-red-500 hover:text-red-700 p-1"
                                                    title="Eliminar modelo"
                                                >
                                                    <X size={14} />
                                                </button>
                                            </div>
                                        ))}
                                        {models.length === 0 && <p className="text-sm text-text-muted italic">No hay modelos</p>}
                                    </div>
                                );
                            })()}
                        </div>

                        {/* Add New Model */}
                        <div className="border-t border-border pt-4">
                            <label className="block text-xs font-semibold text-text-muted uppercase mb-2">Agregar nuevo modelo</label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={newModelName}
                                    onChange={(e) => setNewModelName(e.target.value)}
                                    placeholder="nombre-del-modelo"
                                    className="flex-1 p-2 border border-border bg-background rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none text-text-main"
                                />
                                <button
                                    onClick={() => {
                                        if (newModelName.trim()) {
                                            const modelsListMap: Record<Provider, keyof AppSettings> = {
                                                groq: 'groqModelsList', openrouter: 'openRouterModelsList', openai: 'openaiModelsList', anthropic: 'anthropicModelsList',
                                                cerebras: 'cerebrasModelsList', gemini: 'geminiModelsList', xai: 'xaiModelsList',
                                                custom1: 'custom1ModelsList', custom2: 'custom2ModelsList', chatgpt: 'chatgptModelsList'
                                            };
                                            const currentModels = settings[modelsListMap[modelsManagerProvider]] as string[];
                                            if (!currentModels.includes(newModelName.trim())) {
                                                setSettings(prev => ({
                                                    ...prev,
                                                    [modelsListMap[modelsManagerProvider]]: [newModelName.trim(), ...currentModels]
                                                }));
                                            }
                                            setNewModelName('');
                                        }
                                    }}
                                    disabled={!newModelName.trim()}
                                    className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-primary-hover"
                                >
                                    <Plus size={16} />
                                </button>
                            </div>
                        </div>

                        <div className="mt-4 pt-4 border-t border-border">
                            <button
                                onClick={() => { setShowModelsManager(false); setNewModelName(''); }}
                                className="w-full px-4 py-2 bg-surface-highlight text-text-main rounded-lg text-sm font-medium hover:bg-border"
                            >
                                Cerrar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <FileUploadModal
                isOpen={showFileUploadModal}
                onClose={() => setShowFileUploadModal(false)}
                onSelectFile={() => document.getElementById('hidden-file-input')?.click()}
                onFilesDropped={addFiles}
            />

            {/* MAIN CHAT AREA */}
            <div className="flex-1 flex flex-col h-full relative">
                {/* Header */}
                <header className="h-16 border-b border-border flex items-center justify-between px-4 bg-surface/80 backdrop-blur z-10 transition-colors">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => setIsSidebarOpen(true)}
                            className="p-2 rounded-lg text-text-muted hover:text-text-main hover:bg-surface-highlight transition-colors"
                        >
                            <Menu size={24} />
                        </button>
                        <div className="font-semibold text-text-main truncate max-w-[150px] md:max-w-xs">{currentSession.title}</div>
                    </div>

                    <div className="flex items-center gap-3 max-w-[60%] md:max-w-none">
                        {/* Provider Selector - Clean Dropdown */}
                        {(() => {
                            const connectedMap: Record<Provider, keyof AppSettings> = {
                                groq: 'groqConnected', openrouter: 'openRouterConnected', openai: 'openaiConnected', anthropic: 'anthropicConnected',
                                cerebras: 'cerebrasConnected', gemini: 'geminiConnected', xai: 'xaiConnected',
                                custom1: 'custom1Connected', custom2: 'custom2Connected', chatgpt: 'chatgptConnected'
                            };
                            const labels: Record<Provider, string> = {
                                groq: 'Groq Cloud', openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Claude',
                                cerebras: 'Cerebras', gemini: 'Gemini', xai: 'xAI (Grok)',
                                custom1: settings.custom1Name || 'Personalizado 1', custom2: settings.custom2Name || 'Personalizado 2', chatgpt: 'ChatGPT (cuenta)'
                            };
                            const connectedProviders = (['groq', 'openrouter', 'openai', 'anthropic', 'cerebras', 'gemini', 'xai', 'custom1', 'custom2', 'chatgpt'] as Provider[]).filter(p => settings[connectedMap[p]]);

                            return (
                                <div className="relative">
                                    <select
                                        value={settings.activeProvider}
                                        onChange={(e) => setSettings(s => ({ ...s, activeProvider: e.target.value as Provider }))}
                                        className="appearance-none bg-surface-highlight border border-border text-text-main text-sm font-medium rounded-lg px-3 py-2 pr-8 focus:ring-2 focus:ring-primary outline-none cursor-pointer"
                                        disabled={connectedProviders.length === 0}
                                    >
                                        {connectedProviders.length === 0 ? (
                                            <option value="">Sin conexión</option>
                                        ) : (
                                            connectedProviders.map(p => (
                                                <option key={p} value={p}>{labels[p]}</option>
                                            ))
                                        )}
                                    </select>
                                    <ChevronDown size={16} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                                </div>
                            );
                        })()}

                        {/* Model Switcher - Only show if a provider is connected */}
                        {(() => {
                            const connectedMap: Record<Provider, keyof AppSettings> = {
                                groq: 'groqConnected', openrouter: 'openRouterConnected', openai: 'openaiConnected', anthropic: 'anthropicConnected',
                                cerebras: 'cerebrasConnected', gemini: 'geminiConnected', xai: 'xaiConnected',
                                custom1: 'custom1Connected', custom2: 'custom2Connected', chatgpt: 'chatgptConnected'
                            };
                            const hasConnectedProvider = (['groq', 'openrouter', 'openai', 'anthropic', 'cerebras', 'gemini', 'xai', 'custom1', 'custom2', 'chatgpt'] as Provider[]).some(p => settings[connectedMap[p]]);

                            if (!hasConnectedProvider) return null;

                            const modelsListMap: Record<Provider, keyof AppSettings> = {
                                groq: 'groqModelsList', openrouter: 'openRouterModelsList', openai: 'openaiModelsList', anthropic: 'anthropicModelsList',
                                cerebras: 'cerebrasModelsList', gemini: 'geminiModelsList', xai: 'xaiModelsList',
                                custom1: 'custom1ModelsList', custom2: 'custom2ModelsList', chatgpt: 'chatgptModelsList'
                            };
                            const modelMap: Record<Provider, keyof AppSettings> = {
                                groq: 'groqModel', openrouter: 'openRouterModel', openai: 'openaiModel', anthropic: 'anthropicModel',
                                cerebras: 'cerebrasModel', gemini: 'geminiModel', xai: 'xaiModel',
                                custom1: 'custom1Model', custom2: 'custom2Model', chatgpt: 'chatgptModel'
                            };
                            const ap = settings.activeProvider;
                            return (
                                <div className="w-[180px] md:w-[220px]">
                                    <SearchableSelect
                                        key={ap}
                                        options={settings[modelsListMap[ap]] as string[]}
                                        value={settings[modelMap[ap]] as string}
                                        onChange={(val: string) => setSettings(s => ({ ...s, [modelMap[ap]]: val }))}
                                        placeholder="Elige modelo..."
                                    />
                                </div>
                            );
                        })()}

                        {/* Header Actions */}
                        <div className="h-8 w-px bg-border mx-2" />
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => setSettings(s => ({ ...s, incognitoMode: !s.incognitoMode }))}
                                className={`p-2 rounded-lg transition-all ${settings.incognitoMode ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400' : 'text-text-muted hover:text-text-main hover:bg-surface-highlight'}`}
                                title={settings.incognitoMode ? "Desactivar Incógnito" : "Activar Incógnito"}
                            >
                                {settings.incognitoMode ? <VenetianMask size={20} /> : <EyeOff size={20} />}
                            </button>

                            <button
                                onClick={() => setIsImageModalOpen(true)}
                                className="p-2 text-text-muted hover:text-purple-500 hover:bg-surface-highlight rounded-lg transition-colors"
                                title="Generar imágenes"
                            >
                                <Sparkles size={20} />
                            </button>

                            <div className="relative">
                                <button
                                    onClick={() => setShowShareMenu(v => !v)}
                                    disabled={currentSession.messages.length === 0}
                                    className="p-2 text-text-muted hover:text-text-main hover:bg-surface-highlight rounded-lg transition-colors disabled:opacity-40"
                                    title="Compartir / exportar esta conversación"
                                >
                                    <Share2 size={20} />
                                </button>
                                {showShareMenu && (
                                    <>
                                        <div className="fixed inset-0 z-20" onClick={() => setShowShareMenu(false)} />
                                        <div className="absolute right-0 mt-2 w-64 bg-surface border border-border rounded-xl shadow-xl z-30 p-1.5 text-sm">
                                            {[
                                                { icon: <Share2 size={16} />, label: 'Compartir…', run: async () => { const o = await shareSession(currentSession); if (o !== 'shared' && o !== 'cancelled') flash(shareOutcomeLabel[o]); } },
                                                { icon: <Copy size={16} />, label: 'Copiar como Markdown', run: async () => flash((await copyText(sessionToMarkdown(currentSession))) ? 'Copiado' : 'No se pudo copiar') },
                                                { icon: <FileText size={16} />, label: 'Descargar Markdown (.md)', run: () => exportSessionMarkdown(currentSession, true) },
                                                { icon: <FileJson size={16} />, label: 'Descargar JSON (re-importable)', run: () => exportSessionJSON(currentSession) },
                                            ].map(item => (
                                                <button key={item.label}
                                                    onClick={() => { setShowShareMenu(false); item.run(); }}
                                                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-text-main hover:bg-surface-highlight text-left">
                                                    <span className="text-text-muted">{item.icon}</span>{item.label}
                                                </button>
                                            ))}
                                        </div>
                                    </>
                                )}
                            </div>

                            <button
                                onClick={() => currentSession && setChatToDelete({ id: currentSession.id, title: currentSession.title || 'Chat actual' })}
                                disabled={!currentSession}
                                className="p-2 text-text-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10 rounded-lg transition-colors disabled:opacity-50"
                                title="Borrar conversación"
                            >
                                <Trash2 size={20} />
                            </button>
                        </div>
                    </div>
                </header>

                {/* Messages (acepta soltar archivos) */}
                <div
                    className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 scrollbar-hide bg-background relative"
                    onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setIsDragging(true); } }}
                    onDragLeave={(e) => { if (e.currentTarget === e.target) setIsDragging(false); }}
                    onDrop={(e) => {
                        e.preventDefault();
                        setIsDragging(false);
                        if (e.dataTransfer.files.length) addFiles(Array.from(e.dataTransfer.files));
                    }}
                >
                    {isDragging && (
                        <div className="sticky top-0 inset-x-0 h-full min-h-[200px] z-10 border-2 border-dashed border-primary bg-primary/10 rounded-2xl flex items-center justify-center pointer-events-none">
                            <div className="flex items-center gap-2 text-primary font-semibold"><Upload size={22} /> Suelta los archivos para adjuntarlos</div>
                        </div>
                    )}
                    {currentSession.messages.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-center p-8 opacity-60">
                            <div className="w-20 h-20 bg-primary-light text-primary rounded-full flex items-center justify-center mb-6">
                                <MessageSquare size={32} />
                            </div>
                            <h1 className="text-2xl font-bold text-text-main mb-2">¡Hola! Soy Nodemat.</h1>
                            <p className="text-text-muted max-w-md mb-3">
                                Soy una plataforma pensada para que puedas aprender<br />
                                en profundidad cómo funcionan los modelos LLMs.
                            </p>
                            <p className="text-text-muted max-w-md text-sm">
                                Selecciona un proveedor conectado arriba para comenzar.
                            </p>
                        </div>
                    ) : (
                        currentSession.messages.map((msg, i, all) => (
                            <ChatMessage
                                key={msg.id}
                                msg={msg}
                                onEdit={!isLoading && msg.role === 'user' ? handleEditMessage : undefined}
                                onRegenerate={!isLoading && i === all.length - 1 && msg.role !== 'user' ? handleRegenerate : undefined}
                                onCopy={async (m) => flash((await copyText(m.content || '')) ? 'Copiado' : 'No se pudo copiar')}
                                onShare={handleShareMessage}
                            />
                        ))
                    )}
                    {isLoading && streamText && !pendingTool && (
                        <div className="flex justify-start" aria-live="polite">
                            <div className="max-w-[90%] md:max-w-[80%] p-4 rounded-2xl rounded-bl-none shadow-sm bg-surface border border-border text-text-main leading-relaxed">
                                <Markdown>{streamText}</Markdown>
                                <span className="inline-block w-2 h-4 align-middle bg-primary/70 animate-pulse ml-0.5" aria-hidden="true" />
                            </div>
                        </div>
                    )}
                    {isLoading && (!streamText || pendingTool) && (
                        <div className="flex justify-start animate-pulse">
                            <div className="bg-surface p-4 rounded-2xl rounded-bl-none text-text-muted text-sm border border-border">
                                {pendingTool ? `Esperando tu aprobación para ${pendingTool.originalName}…`
                                    : toolProgress ? `Ejecutando ${toolProgress.tool}… ${toolProgress.progress.total ? `${Math.round(100 * toolProgress.progress.progress / toolProgress.progress.total)}% ` : ''}${toolProgress.progress.message || ''}`
                                        : 'Escribiendo...'}
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>

                {/* Input Area */}
                <div className="p-4 md:p-6 bg-surface border-t border-border">
                    <div className="max-w-4xl mx-auto w-full">

                        {(attachments.length > 0 || processingFiles > 0) && (
                            <div className="flex gap-2 mb-3 overflow-x-auto py-2">
                                {processingFiles > 0 && (
                                    <div className="h-16 px-3 shrink-0 bg-surface-highlight flex items-center gap-2 rounded-lg border border-border text-xs text-text-muted" role="status">
                                        <RefreshCw size={14} className="animate-spin" /> Procesando {processingFiles} archivo{processingFiles > 1 ? 's' : ''}…
                                    </div>
                                )}
                                {attachments.map((att, i) => (
                                    <div key={i} className="relative group shrink-0 animate-in zoom-in-90 duration-200">
                                        {att.type.startsWith('image/') ? (
                                            <img src={att.data} alt={att.name} title={att.name} className="h-16 w-16 object-cover rounded-lg border border-border shadow-sm" />
                                        ) : (
                                            <div className="h-16 w-28 bg-surface-highlight flex flex-col items-center justify-center gap-1 rounded-lg border border-border text-[10px] text-text-muted font-medium p-1 text-center shadow-sm" title={att.name}>
                                                <AttachmentIcon type={att.type} name={att.name} size={18} className={att.type === 'application/pdf' ? 'text-red-500' : ''} />
                                                <span className="truncate w-full">{att.name}</span>
                                                {att.size ? <span className="opacity-70">{formatBytes(att.size)}</span> : null}
                                            </div>
                                        )}
                                        <button
                                            onClick={() => setAttachments(prev => prev.filter((_, idx) => idx !== i))}
                                            aria-label={`Quitar ${att.name}`}
                                            className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full p-0.5 hover:bg-red-600 shadow-md transition-transform hover:scale-110"
                                        >
                                            <X size={12} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div
                            className="flex items-end gap-2 p-2 rounded-2xl border border-border shadow-sm focus-within:ring-2 focus-within:ring-primary focus-within:border-primary transition-all"
                            style={{ backgroundColor: THEMES[settings.theme]?.primaryLight || '#f3f4f6' }}
                        >
                            <button
                                onClick={() => setIsSystemPromptOpen(true)}
                                className={`p-2 rounded-full transition-colors ${settings.systemPrompt ? 'text-primary bg-primary/10' : 'text-text-muted hover:text-text-main hover:bg-surface-highlight'}`}
                                title="Configurar Instrucciones Personalizadas"
                            >
                                <FileCode size={20} />
                            </button>

                            <div className="relative group">
                                <button
                                    onClick={() => setShowFileUploadModal(true)}
                                    className="p-2 text-text-muted hover:text-text-main hover:bg-surface-highlight rounded-full transition-colors"
                                    disabled={isLoading}
                                    title="Adjuntar archivo"
                                >
                                    <Paperclip size={20} />
                                </button>
                                <input
                                    type="file"
                                    multiple
                                    accept={ACCEPT_ATTRIBUTE}
                                    onChange={handleFileUpload}
                                    className="hidden"
                                    id="hidden-file-input"
                                />
                            </div>

                            <DictationButton
                                settings={settings}
                                disabled={isLoading}
                                onText={(text) => setInput(prev => prev ? `${prev.trimEnd()} ${text}` : text)}
                                onError={flash}
                            />

                            {hasMCPLibrary && (
                                <button
                                    onClick={() => setIsMCPLibraryOpen(true)}
                                    className="p-2 text-text-muted hover:text-text-main hover:bg-surface-highlight rounded-full transition-colors"
                                    title="Prompts y recursos de tus servidores MCP"
                                    aria-label="Prompts y recursos MCP"
                                >
                                    <BookOpen size={20} />
                                </button>
                            )}

                            <textarea
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                onPaste={handlePaste}
                                placeholder="Escribe un mensaje... (puedes pegar o soltar archivos)"
                                className="flex-1 bg-transparent max-h-32 min-h-[44px] py-3 text-text-main placeholder-text-muted outline-none resize-none scrollbar-hide text-sm md:text-base leading-relaxed"
                                rows={1}
                            />

                            {isLoading ? (
                                <button
                                    onClick={handleStop}
                                    className="p-3 rounded-xl transition-all shadow-sm bg-text-main text-text-inverted hover:opacity-90"
                                    title="Detener"
                                >
                                    <Square size={20} />
                                </button>
                            ) : (
                                <button
                                    onClick={handleSend}
                                    disabled={(!input.trim() && attachments.length === 0) || processingFiles > 0}
                                    className={`p-3 rounded-xl transition-all shadow-sm ${!input.trim() && attachments.length === 0
                                        ? 'bg-surface-highlight text-text-muted cursor-not-allowed'
                                        : 'bg-primary text-white hover:bg-primary-hover hover:scale-105 active:scale-95'
                                        }`}
                                >
                                    <Send size={20} />
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="mt-2 text-center">
                        <p className="text-[10px] text-text-muted">

                            Nodemat puede cometer errores. Considera verificar la información importante. • {settings.incognitoMode ? '🛡️ Modo Incógnito Activado' : '💾 Historial Local Activo'}
                        </p>

                    </div>
                </div>
            </div>

            {toast && (
                <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[130] bg-black/85 text-white text-sm px-4 py-2 rounded-full shadow-lg">
                    {toast}
                </div>
            )}
        </div>

    );
}
