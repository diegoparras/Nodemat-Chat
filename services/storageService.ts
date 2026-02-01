/**
 * ============================================================================
 * STORAGE SERVICE - IndexedDB Persistence Layer
 * ============================================================================
 * 
 * Este servicio maneja toda la persistencia de datos de la aplicación utilizando
 * IndexedDB como almacenamiento principal. Proporciona:
 * 
 * - Almacenamiento de sesiones de chat de forma individual (no monolítico)
 * - Un índice de metadatos para carga rápida del sidebar
 * - Migración automática desde LocalStorage (versiones anteriores)
 * - Estimación de uso de almacenamiento
 * 
 * ARQUITECTURA:
 * - Cada chat se guarda con la key: `nexus_chat_{id}`
 * - Un índice de metadatos se guarda en: `nexus_chat_index`
 * - Esto permite cargar el sidebar sin leer todos los mensajes
 * 
 * SEGURIDAD:
 * - Todos los datos se almacenan SOLO en el navegador del usuario
 * - No hay transmisión de datos a servidores externos desde este servicio
 */

import { get, set, del, keys, clear } from 'idb-keyval';
import { ChatSession } from '../types';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Clave para el índice de metadatos de todos los chats */
const INDEX_KEY = 'nexus_chat_index';

/** Clave legacy para migración desde versiones antiguas (monolito) */
const OLD_SESSION_KEY = 'nexus_sessions';

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Determina si una key de IDB pertenece a un chat individual
 * @param key - La key a verificar
 * @returns true si es una key de chat válida
 */
const isChatKey = (key: string) => key.startsWith('nexus_chat_') && key !== INDEX_KEY;

// ============================================================================
// STORAGE SERVICE
// ============================================================================

export const storageService = {
    // ========================================================================
    // CORE OPERATIONS
    // ========================================================================

    /**
     * Guarda una sesión de chat completa en IndexedDB.
     * También actualiza el índice de metadatos para el sidebar.
     * 
     * @param session - La sesión de chat a guardar
     */
    async saveSession(session: ChatSession): Promise<void> {
        // Guardar la sesión completa en su propia key
        await set(`nexus_chat_${session.id}`, session);

        // Actualizar el índice con los metadatos (id, título, fecha)
        await this.updateIndex(session);
    },

    /**
     * Carga todas las sesiones de chat desde IndexedDB.
     * Utiliza el índice para cargar los metadatos primero, luego
     * carga los cuerpos completos de cada chat en paralelo.
     * 
     * @returns Array de sesiones ordenadas por fecha de creación (más reciente primero)
     */
    async loadAllSessions(): Promise<ChatSession[]> {
        // Intentar cargar desde el índice
        const index = await get<any[]>(INDEX_KEY);

        if (index && Array.isArray(index)) {
            // Cargar todas las sesiones en paralelo para mejor performance
            const promises = index.map(async (meta) => {
                const session = await get<ChatSession>(`nexus_chat_${meta.id}`);
                // Fallback a mensajes vacíos si el cuerpo no existe
                return session || { ...meta, messages: [] };
            });

            const sessions = await Promise.all(promises);
            // Ordenar por fecha de creación descendente
            return sessions.sort((a, b) => b.createdAt - a.createdAt);
        }

        return [];
    },

    /**
     * Elimina una sesión de chat específica de IndexedDB.
     * También la remueve del índice de metadatos.
     * 
     * @param sessionId - El ID de la sesión a eliminar
     */
    async deleteSession(sessionId: string): Promise<void> {
        await del(`nexus_chat_${sessionId}`);
        await this.removeFromIndex(sessionId);
    },

    /**
     * Limpia TODOS los datos de la aplicación de IndexedDB.
     * ADVERTENCIA: Esta acción es destructiva e irreversible.
     * Solo elimina keys que pertenecen a esta app (prefijo: nexus_)
     */
    async clearAll(): Promise<void> {
        const allKeys = await keys();
        for (const key of allKeys) {
            if (typeof key === 'string' && key.startsWith('nexus_')) {
                await del(key);
            }
        }
    },

    // ========================================================================
    // INDEX MANAGEMENT
    // ========================================================================

    /**
     * Actualiza el índice de metadatos con la información de una sesión.
     * Si la sesión ya existe en el índice, la actualiza. Si no, la agrega.
     * 
     * @param session - La sesión cuya metadata se debe indexar
     */
    async updateIndex(session: ChatSession): Promise<void> {
        const index = await get<any[]>(INDEX_KEY) || [];
        const meta = { id: session.id, title: session.title, createdAt: session.createdAt };

        const existingIdx = index.findIndex(i => i.id === session.id);
        if (existingIdx >= 0) {
            index[existingIdx] = meta;
        } else {
            index.unshift(meta); // Agregar al principio (más reciente)
        }

        await set(INDEX_KEY, index);
    },

    /**
     * Remueve una sesión del índice de metadatos.
     * 
     * @param sessionId - El ID de la sesión a remover del índice
     */
    async removeFromIndex(sessionId: string): Promise<void> {
        const index = await get<any[]>(INDEX_KEY) || [];
        const newIndex = index.filter(i => i.id !== sessionId);
        await set(INDEX_KEY, newIndex);
    },

    // ========================================================================
    // MIGRATION LOGIC
    // ========================================================================

    /**
     * Migra datos desde LocalStorage (versiones anteriores) a IndexedDB.
     * Esta función es crítica para la retrocompatibilidad.
     * 
     * Maneja dos formatos legacy:
     * 1. "Middle Era" (Split LocalStorage): índice + chats individuales en LS
     * 2. "Ancient Era" (Monolith): todas las sesiones en una sola key
     * 
     * @returns true si se migraron datos, false si no había nada que migrar
     */
    async migrateFromLocalStorage(): Promise<boolean> {
        // Verificar si ya tenemos datos en IDB (evitar doble migración)
        const existingIndexIDB = await get(INDEX_KEY);
        if (existingIndexIDB) {
            // Ya hay datos en IDB, no migrar
            return false;
        }

        let migratedCount = 0;

        // 1. Intentar migrar desde formato "Split" (Middle Era)
        const lsIndexStr = localStorage.getItem(INDEX_KEY);
        if (lsIndexStr) {
            try {
                const index = JSON.parse(lsIndexStr);
                await set(INDEX_KEY, index);

                // Migrar cada chat individualmente
                for (const meta of index) {
                    const chatStr = localStorage.getItem(`nexus_chat_${meta.id}`);
                    if (chatStr) {
                        try {
                            const chat = JSON.parse(chatStr);
                            await set(`nexus_chat_${meta.id}`, chat);
                            migratedCount++;
                        } catch { /* Ignorar chats corruptos */ }
                    }
                }
            } catch { /* Ignorar errores de parseo */ }
        } else {
            // 2. Intentar migrar desde formato "Monolith" (Ancient Era)
            const oldSessionsStr = localStorage.getItem(OLD_SESSION_KEY);
            if (oldSessionsStr) {
                try {
                    const oldSessions = JSON.parse(oldSessionsStr);
                    if (Array.isArray(oldSessions)) {
                        for (const session of oldSessions) {
                            await this.saveSession(session);
                            migratedCount++;
                        }
                    }
                } catch { /* Ignorar errores de parseo */ }
            }
        }

        return migratedCount > 0;
    },

    // ========================================================================
    // STATISTICS
    // ========================================================================

    /**
     * Obtiene una estimación del uso de almacenamiento del navegador.
     * Utiliza la Storage API si está disponible.
     * 
     * @returns Objeto con usage y quota en bytes, o undefined si no está soportado
     */
    async getUsageEstimate(): Promise<{ usage: number, quota: number } | undefined> {
        if (navigator.storage && navigator.storage.estimate) {
            const estimate = await navigator.storage.estimate();
            if (typeof estimate.usage === 'number' && typeof estimate.quota === 'number') {
                return { usage: estimate.usage, quota: estimate.quota };
            }
        }
        return undefined;
    }
};
