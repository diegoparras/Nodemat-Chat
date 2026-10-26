import React, { useState } from 'react';
import { CheckCircle2, ExternalLink, AlertTriangle, RefreshCw, LogIn, FileJson, ChevronDown } from 'lucide-react';
import { AppSettings } from '../types';
import { SearchableSelect } from './SearchableSelect';
import { SecretInput } from './SecretInput';
import {
    startChatGPTLogin, completeChatGPTLogin, importCodexAuthJson, accountToSettings, fetchChatGPTModels, ensureFreshChatGPTToken, joinVersion, splitVersion, ChatGPTAccount
} from '../services/chatgptAuth';

interface Props {
    settings: AppSettings;
    setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
}

/**
 * Conexión con una cuenta de ChatGPT (experimental).
 * Ver services/chatgptAuth.ts para el detalle del flujo OAuth.
 */
export const ChatGPTAccountCard: React.FC<Props> = ({ settings, setSettings }) => {
    const [step, setStep] = useState<'idle' | 'waiting'>('idle');
    const [pasted, setPasted] = useState('');
    const [authJson, setAuthJson] = useState('');
    const [showImport, setShowImport] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    // Versión de Codex en tres bloques; se guarda unida ("0.164.0") en los ajustes locales
    const [versionParts, setVersionParts] = useState<string[]>(
        () => splitVersion(settings.chatgptClientVersion) || ['', '', '']
    );
    const joinedVersion = joinVersion(versionParts);

    const setVersion = (parts: string[]) => {
        setVersionParts(parts);
        const joined = joinVersion(parts);
        if (joined) setSettings(s => ({ ...s, chatgptClientVersion: joined }));
    };

    const updateVersionPart = (index: number, value: string) => {
        const pasted = splitVersion(value);
        if (pasted) return setVersion(pasted);
        setVersion(versionParts.map((p, i) => i === index ? value.replace(/\D/g, '').slice(0, 5) : p));
    };

    const refreshModels = (clientVersion?: string) => run(async () => {
        const { accessToken, accountId } = await ensureFreshChatGPTToken(settings, p => setSettings(s => ({ ...s, ...p })));
        const models = await fetchChatGPTModels(accessToken, accountId, clientVersion || undefined);
        setSettings(s => ({
            ...s,
            chatgptModelsList: models,
            // Si el modelo elegido ya no está disponible, pasar al primero de la lista
            chatgptModel: models.includes(s.chatgptModel) ? s.chatgptModel : models[0]
        }));
    });

    const finish = async (acc: ChatGPTAccount) => {
        const models = await fetchChatGPTModels(acc.access_token, acc.account_id || '', settings.chatgptClientVersion || undefined);
        setSettings(s => ({
            ...s,
            ...accountToSettings(acc),
            chatgptConnected: true,
            chatgptModelsList: models,
            chatgptModel: models.includes(s.chatgptModel) ? s.chatgptModel : models[0]
        }));
        setStep('idle');
        setPasted('');
        setAuthJson('');
    };

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        setError('');
        try { await fn(); } catch (e: any) { setError(e.message || String(e)); } finally { setBusy(false); }
    };

    const openLogin = () => run(async () => {
        const url = await startChatGPTLogin();
        window.open(url, '_blank', 'noopener');
        setStep('waiting');
    });

    const disconnect = () => setSettings(s => ({
        ...s,
        chatgptKey: '', chatgptRefreshToken: '', chatgptAccountId: '', chatgptExpiresAt: 0,
        chatgptEmail: '', chatgptPlan: '', chatgptConnected: false
    }));

    return (
        <div className={`border rounded-xl p-5 transition-all bg-surface md:col-span-2 ${settings.chatgptConnected ? 'border-green-200 bg-green-50/20' : 'border-border'}`}>
            <div className="flex items-center justify-between mb-3 gap-2">
                <div className="flex items-center gap-2 font-bold text-text-main">
                    ChatGPT (cuenta)
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">EXPERIMENTAL</span>
                    {settings.chatgptConnected && <CheckCircle2 size={16} className="text-green-600" />}
                </div>
                {settings.chatgptConnected && (
                    <button onClick={disconnect} className="text-red-500 text-xs font-medium hover:underline">Desconectar</button>
                )}
            </div>

            {settings.chatgptConnected ? (
                <div className="space-y-3">
                    <p className="text-xs text-text-muted">
                        {settings.chatgptEmail || 'Cuenta conectada'}
                        {settings.chatgptPlan && <> · plan <strong className="text-text-main">{settings.chatgptPlan}</strong></>}
                        {settings.chatgptExpiresAt > 0 && <> · token renovado automáticamente</>}
                    </p>
                    <div className="flex gap-2 items-end">
                        <div className="flex-1">
                            <label className="block text-xs font-semibold text-text-muted mb-1 uppercase">Modelo</label>
                            <SearchableSelect
                                options={settings.chatgptModelsList}
                                value={settings.chatgptModel}
                                onChange={(val: string) => setSettings(s => ({ ...s, chatgptModel: val }))}
                            />
                        </div>
                        <button
                            onClick={() => refreshModels(settings.chatgptClientVersion)}
                            className="p-2.5 border border-border rounded-lg text-text-muted hover:text-text-main" title="Actualizar lista de modelos"
                        >
                            <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
                        </button>
                    </div>

                    {/* Versión de Codex: el backend lista los modelos según la versión del cliente */}
                    <div className="pt-1">
                        <label className="block text-xs font-semibold text-text-muted mb-1 uppercase">Versión de Codex</label>
                        <div className="flex flex-wrap items-center gap-2">
                            <div className="flex items-center gap-1">
                                {versionParts.map((part, i) => (
                                    <React.Fragment key={i}>
                                        {i > 0 && <span className="font-bold text-text-muted">.</span>}
                                        <input
                                            type="text"
                                            inputMode="numeric"
                                            value={part}
                                            onChange={e => updateVersionPart(i, e.target.value)}
                                            onPaste={e => {
                                                const parts = splitVersion(e.clipboardData.getData('text'));
                                                if (parts) { e.preventDefault(); setVersion(parts); }
                                            }}
                                            placeholder={['0', '164', '0'][i]}
                                            aria-label={['Versión mayor', 'Versión menor', 'Parche'][i]}
                                            className="w-16 p-2 border border-border bg-background rounded-lg text-sm font-mono text-center text-text-main outline-none focus:ring-2 focus:ring-primary"
                                        />
                                    </React.Fragment>
                                ))}
                            </div>
                            <button
                                onClick={() => refreshModels(joinedVersion)}
                                disabled={busy || !joinedVersion}
                                className="px-3 py-2 bg-primary text-white rounded-lg text-xs font-medium disabled:opacity-50"
                            >
                                Aplicar y actualizar modelos
                            </button>
                        </div>
                        <p className="text-[11px] text-text-muted mt-1">
                            {joinedVersion
                                ? <>Se enviará <code>{joinedVersion}</code>. </>
                                : <span className="text-amber-600">Completa los tres números. </span>}
                            La última está en{' '}
                            <a href="https://github.com/openai/codex/releases/latest" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                github.com/openai/codex/releases
                            </a>{' '}(ej. <code>rust-v0.164.0</code> → 0 · 164 · 0). Puedes pegarla entera en cualquier casilla.
                        </p>
                    </div>
                </div>
            ) : (
                <div className="space-y-3">
                    <div className="flex gap-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/10 border border-amber-200/60 dark:border-amber-800/30 rounded-lg p-3">
                        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                        <p>
                            Usa tu suscripción de ChatGPT con el mismo login que Codex CLI / OpenClaw. No es una API pública:
                            consume los límites de tu plan, OpenAI puede cambiarlo o restringirlo, y el acceso con cuentas
                            <strong> Free</strong> no está garantizado. Para algo estable, usa una API key de OpenAI.
                        </p>
                    </div>

                    {step === 'idle' ? (
                        <button
                            onClick={openLogin}
                            disabled={busy}
                            className="flex items-center gap-2 px-4 py-2 bg-text-main text-text-inverted rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
                        >
                            <LogIn size={16} /> Iniciar sesión con ChatGPT <ExternalLink size={14} />
                        </button>
                    ) : (
                        <div className="space-y-2 text-sm">
                            <ol className="list-decimal pl-5 text-xs text-text-muted space-y-1">
                                <li>Inicia sesión en la pestaña de OpenAI que se abrió.</li>
                                <li>Al terminar, el navegador irá a <code>localhost:1455</code> y mostrará un error de conexión. <strong>Es normal.</strong></li>
                                <li>Copia la dirección completa de esa pestaña y pégala aquí. Contiene un código de un solo uso: no la compartas con nadie.</li>
                            </ol>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={pasted}
                                    onChange={e => setPasted(e.target.value)}
                                    placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                                    className="flex-1 p-2.5 border border-border bg-background rounded-lg text-xs font-mono text-text-main outline-none focus:ring-2 focus:ring-primary"
                                />
                                <button
                                    onClick={() => run(async () => finish(await completeChatGPTLogin(pasted)))}
                                    disabled={busy || !pasted.trim()}
                                    className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50"
                                >
                                    {busy ? <RefreshCw size={14} className="animate-spin" /> : 'Conectar'}
                                </button>
                            </div>
                            <button onClick={() => setStep('idle')} className="text-xs text-text-muted hover:underline">Cancelar</button>
                        </div>
                    )}

                    <div>
                        <button onClick={() => setShowImport(v => !v)} className="flex items-center gap-1 text-xs text-text-muted hover:text-text-main">
                            <FileJson size={14} /> ¿Ya usas Codex CLI? Importar ~/.codex/auth.json
                            <ChevronDown size={12} className={`transition-transform ${showImport ? 'rotate-180' : ''}`} />
                        </button>
                        {showImport && (
                            <div className="mt-2 space-y-2">
                                <p className="text-[11px] text-text-muted">
                                    Ojo: los tokens se renuevan "rotando", así que al compartir la sesión, Codex CLI o Nodemat
                                    puede pedirte iniciar sesión de nuevo más adelante.
                                </p>
                                <textarea
                                    value={authJson}
                                    onChange={e => setAuthJson(e.target.value)}
                                    placeholder='{"tokens": {"access_token": "...", "refresh_token": "...", ...}}'
                                    className="w-full h-24 p-2 border border-border bg-background rounded-lg text-[11px] font-mono text-text-main"
                                />
                                <button
                                    onClick={() => run(async () => finish(importCodexAuthJson(authJson)))}
                                    disabled={busy || !authJson.trim()}
                                    className="px-3 py-1.5 border border-border rounded-lg text-xs font-medium text-text-main hover:bg-surface-highlight disabled:opacity-50"
                                >
                                    Importar sesión
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {error && <p className="mt-3 text-xs text-red-500 whitespace-pre-wrap">{error}</p>}

            {/proxy/i.test(error) && (
                // El rechazo viene del servidor de Nodemat (NODEMAT_PROXY_TOKEN), no de OpenAI:
                // el código de la URL no se llegó a usar, así que se puede reintentar con la misma URL.
                <div className="mt-2 space-y-1 text-xs text-text-muted">
                    <p>
                        Este despliegue tiene definida la variable <code>NODEMAT_PROXY_TOKEN</code>. Escribe aquí el mismo valor
                        y vuelve a pulsar <strong>Conectar</strong> (la URL pegada sigue sirviendo).
                    </p>
                    <SecretInput
                        value={settings.proxyToken || ''}
                        onChange={e => { const val = e.target.value; setSettings(s => ({ ...s, proxyToken: val })); }}
                        placeholder="Token del proxy"
                        className="p-2 text-sm border border-border bg-background text-text-main rounded-lg outline-none font-mono"
                    />
                </div>
            )}
        </div>
    );
};
