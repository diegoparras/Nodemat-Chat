import React, { useState } from 'react';
import { AlertTriangle, RefreshCw, Download } from 'lucide-react';

interface ChatImageProps {
    src?: string;
    alt?: string;
    onDownload: (src: string) => void;
}

export const ChatImage: React.FC<ChatImageProps> = ({ src, alt, onDownload }) => {
    const [error, setError] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);

    if (error) {
        return (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg inline-flex items-center gap-2 my-2 max-w-full overflow-hidden">
                <AlertTriangle size={16} className="text-red-500 shrink-0" />
                <div className="flex flex-col overflow-hidden">
                    <span className="text-xs text-red-500 font-medium">Error cargando imagen</span>
                    <a href={src} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline truncate">
                        {src}
                    </a>
                </div>
            </div>
        );
    }

    return (
        <div className="relative group inline-block max-w-full my-2">
            {!isLoaded && (
                <div className="w-full h-48 bg-surface-highlight animate-pulse rounded-xl border border-border flex items-center justify-center text-text-muted">
                    <RefreshCw className="animate-spin" />
                </div>
            )}
            <img
                src={src}
                alt={alt || "Imagen generada"}
                className={`rounded-xl border border-border shadow-sm max-h-[500px] object-contain bg-black/5 transition-opacity duration-300 ${isLoaded ? 'opacity-100' : 'opacity-0 absolute top-0 left-0'}`}
                onLoad={() => setIsLoaded(true)}
                onError={() => setError(true)}
                loading="lazy"
            />
            {isLoaded && (
                <button
                    onClick={(e) => { e.preventDefault(); onDownload(src || ''); }}
                    className="absolute top-2 right-2 bg-black/60 hover:bg-black/80 text-white p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-all backdrop-blur-sm shadow-md hover:scale-105"
                    title="Descargar Imagen"
                >
                    <Download size={18} />
                </button>
            )}
        </div>
    );
};
