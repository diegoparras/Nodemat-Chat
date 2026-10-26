import { describe, expect, it } from 'vitest';
import { getFriendlyLLMError } from '../services/llmService';
import { isValidClientVersion, pickVisibleModels } from '../server/chatgpt';
import { joinVersion, splitVersion } from '../services/chatgptAuth';

describe('mensajes de error de proveedores', () => {
    it('reconoce el límite de gasto de una key de OpenRouter (no es la conexión)', () => {
        const msg = getFriendlyLLMError('Key limit exceeded (total limit). Manage it using https://openrouter.ai/... $20.00 of $20.00 used; does not reset.', 'OpenRouter');
        expect(msg).toContain('💳');
        expect(msg).toContain('OpenRouter');
        expect(msg).not.toContain('Verifica tu conexión');
    });

    it('distingue key inválida, rate limit y red', () => {
        expect(getFriendlyLLMError('401 Invalid API key', 'OpenAI')).toContain('🔑');
        expect(getFriendlyLLMError('429 Too Many Requests', 'Groq')).toContain('⏳');
        expect(getFriendlyLLMError('Failed to fetch', 'Gemini')).toContain('Verifica tu conexión');
        expect(getFriendlyLLMError('algo raro', 'xAI')).toBe('Error de xAI: algo raro');
    });
});

describe('modelos de la cuenta de ChatGPT', () => {
    it('muestra sólo los modelos visibles, ordenados por prioridad', () => {
        const models = pickVisibleModels([
            { slug: 'codex-auto-review', visibility: 'hide', priority: 0 },
            { slug: 'modelo-b', visibility: 'list', priority: 5 },
            { slug: 'modelo-a', visibility: 'list', priority: 1 },
            { slug: 'interno', visibility: 'none', priority: 2 },
            { slug: 'modelo-a', visibility: 'list', priority: 1 }
        ]);
        expect(models).toEqual(['modelo-a', 'modelo-b']);
    });

    it('acepta respuestas sin campo visibility', () => {
        expect(pickVisibleModels([{ id: 'x' }, { name: 'y' }, {}])).toEqual(['x', 'y']);
    });
});

describe('versión de Codex en tres bloques', () => {
    it('une los bloques con puntos y exige los tres números', () => {
        expect(joinVersion(['0', '164', '0'])).toBe('0.164.0');
        expect(joinVersion([' 0', '0165 ', '2'])).toBe('0.165.2');
        expect(joinVersion(['0', '', '0'])).toBe('');
        expect(joinVersion(['0', 'abc', '0'])).toBe('');
    });

    it('separa una versión pegada, con o sin el prefijo de GitHub', () => {
        expect(splitVersion('rust-v0.164.0')).toEqual(['0', '164', '0']);
        expect(splitVersion('0.170.3')).toEqual(['0', '170', '3']);
        expect(splitVersion('164')).toBeNull();
    });

    it('el servidor sólo acepta N.N.N', () => {
        expect(isValidClientVersion('0.164.0')).toBe(true);
        expect(isValidClientVersion('0.164')).toBe(false);
        expect(isValidClientVersion('0.164.0&x=1')).toBe(false);
        expect(isValidClientVersion(undefined)).toBe(false);
    });
});
