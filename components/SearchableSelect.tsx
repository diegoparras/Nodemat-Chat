import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';

interface SearchableSelectProps {
    options: string[];
    value: string;
    onChange: (val: string) => void;
    disabled?: boolean;
    placeholder?: string;
}

export const SearchableSelect: React.FC<SearchableSelectProps> = ({
    options,
    value,
    onChange,
    disabled,
    placeholder = "Seleccionar..."
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const dropdownRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const filtered = options.filter(opt => opt.toLowerCase().includes(search.toLowerCase()));

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isOpen]);

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                type="button"
                onClick={() => !disabled && setIsOpen(!isOpen)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-surface-highlight border border-border text-text-main text-sm font-medium rounded-lg transition-all focus:ring-2 focus:ring-primary outline-none ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
                <span className="truncate">{value || placeholder}</span>
                <ChevronDown size={16} className={`text-text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-surface border border-border rounded-xl shadow-xl z-[100] overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                    <div className="p-2 border-b border-border bg-surface-highlight/50 flex items-center gap-2">
                        <Search size={14} className="text-text-muted" />
                        <input
                            ref={inputRef}
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Buscar modelo..."
                            className="w-full bg-transparent text-sm text-text-main outline-none placeholder-text-muted"
                        />
                        {search && (
                            <button onClick={() => setSearch('')} className="text-text-muted hover:text-text-main">
                                <X size={14} />
                            </button>
                        )}
                    </div>
                    <div className="max-h-60 overflow-y-auto py-1 scrollbar-hide">
                        {filtered.length > 0 ? (
                            filtered.map((opt, i) => (
                                <button
                                    key={i}
                                    onClick={() => {
                                        onChange(opt);
                                        setIsOpen(false);
                                        setSearch('');
                                    }}
                                    className={`w-full text-left px-4 py-2 text-sm hover:bg-surface-highlight transition-colors ${value === opt ? 'text-primary font-semibold bg-primary/5' : 'text-text-main'}`}
                                >
                                    {opt}
                                </button>
                            ))
                        ) : (
                            <div className="px-4 py-4 text-center">
                                <p className="text-xs text-text-muted italic">No se encontraron resultados</p>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
