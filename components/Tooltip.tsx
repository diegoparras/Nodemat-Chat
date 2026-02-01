import React, { useState } from 'react';
import { HelpCircle, X } from 'lucide-react';

interface TooltipProps {
  title: string;
  explanation: string;
  active: boolean;
  children: React.ReactNode;
}

export const Tooltip: React.FC<TooltipProps> = ({ title, explanation, active, children }) => {
  const [isOpen, setIsOpen] = useState(false);

  if (!active) return <>{children}</>;

  return (
    <>
      <div className="flex items-center gap-2 w-full">
        {children}
        <button 
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsOpen(true);
          }}
          className="text-brand-500 hover:text-brand-700 transition-colors animate-pulse shrink-0"
          aria-label="Más información"
        >
          <HelpCircle size={18} />
        </button>
      </div>
      
      {isOpen && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
          onClick={() => setIsOpen(false)}
        >
          <div 
            className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-brand-50 p-4 border-b border-brand-100 flex justify-between items-center">
                <h3 className="font-bold text-brand-700 text-lg flex items-center gap-2">
                    <HelpCircle size={20} />
                    {title}
                </h3>
                <button 
                    onClick={() => setIsOpen(false)}
                    className="text-brand-400 hover:text-brand-700 transition-colors"
                >
                    <X size={20} />
                </button>
            </div>
            
            <div className="p-6">
                <p className="text-gray-700 leading-relaxed text-base">
                    {explanation}
                </p>
            </div>
            
            <div className="bg-gray-50 p-3 text-center border-t border-gray-100">
                <button 
                    onClick={() => setIsOpen(false)}
                    className="text-sm font-medium text-brand-600 hover:text-brand-800"
                >
                    Entendido, gracias
                </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};