export type Provider = 'groq' | 'openrouter' | 'openai' | 'cerebras' | 'gemini' | 'xai' | 'custom1' | 'custom2';

export interface Message {
  id: string;
  role: 'user' | 'model' | 'system' | 'tool' | 'assistant';
  content: string | null;
  timestamp: number;
  attachments?: Attachment[];
  toolCalls?: any[];
  tool_call_id?: string;
  name?: string;
  usage?: {
    input: number;
    output: number;
    total: number;
  };
  rawDebug?: {
    requestId: string;
    provider: string;
    model: string;
    requestPayload: any;
    responsePayload: any;
  };
}

export interface Attachment {
  name: string;
  type: string;
  data: string; // Base64 or Text
  extractedText?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

export type MCPTransport = 'sse' | 'http-stream';
export type MCPAuthType = 'none' | 'api-key' | 'oauth';

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: any;
}

export interface MCPServer {
  id: string;
  url: string;
  transport: MCPTransport;
  authType: MCPAuthType;
  authToken: string;
  status: 'idle' | 'loading' | 'connected' | 'error';
  errorMessage: string;
  tools: MCPTool[];
  enabledTools: string[];
}

export type ThemeOption = 'ocean' | 'mint' | 'lavender' | 'coral' | 'amber' | 'rose' | 'teal' | 'slate';

// Provider configuration interface for cleaner state management
export interface ProviderConfig {
  key: string;
  model: string;
  connected: boolean;
  modelsList: string[];
}

export interface AppSettings {
  // Appearance
  theme: ThemeOption;
  darkMode: boolean;

  // Provider Configurations
  groqKey: string;
  groqModel: string;
  groqConnected: boolean;
  groqModelsList: string[];

  openRouterKey: string;
  openRouterModel: string;
  openRouterConnected: boolean;
  openRouterModelsList: string[];

  openaiKey: string;
  openaiModel: string;
  openaiConnected: boolean;
  openaiModelsList: string[];



  cerebrasKey: string;
  cerebrasModel: string;
  cerebrasConnected: boolean;
  cerebrasModelsList: string[];

  geminiKey: string;
  geminiModel: string;
  geminiConnected: boolean;
  geminiModelsList: string[];

  xaiKey: string;
  xaiModel: string;
  xaiConnected: boolean;
  xaiModelsList: string[];

  // Custom Providers
  custom1Name: string;
  custom1Key: string;
  custom1Url: string;
  custom1Model: string;
  custom1Connected: boolean;
  custom1ModelsList: string[];

  custom2Name: string;
  custom2Key: string;
  custom2Url: string;
  custom2Model: string;
  custom2Connected: boolean;
  custom2ModelsList: string[];

  // System Prompt
  systemPrompt: string;



  // Active Selection
  activeProvider: Provider;

  // MCP Configuration
  mcpRegistryUrl: string;
  mcpServers: MCPServer[];

  // General
  incognitoMode: boolean;
}

// Helper to get provider display name
export const PROVIDER_NAMES: Record<Provider, string> = {
  groq: 'Groq',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',

  cerebras: 'Cerebras',
  gemini: 'Gemini (AI Studio)',
  xai: 'xAI (Grok)',
  custom1: 'Personalizado 1',
  custom2: 'Personalizado 2'

};