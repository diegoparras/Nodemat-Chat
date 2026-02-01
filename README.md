# 🤖 Nodemat Chat

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![React](https://img.shields.io/badge/React-19-61DAFB.svg)
![Vite](https://img.shields.io/badge/Vite-7-646CFF.svg)

**Nodemat Chat** es una plataforma de código abierto diseñada para **aprender cómo funcionan los Modelos de Lenguaje (LLMs) a través de sus APIs**. Todo se desarrolla y ejecuta en local, sin necesidad de un servidor backend, lo que la convierte en una herramienta ideal para experimentación y educación.

---

## 🎯 ¿Para Quién es Nodemat?

- **Desarrolladores** que quieren entender la estructura de las APIs de LLM (OpenAI, Google AI, etc.)
- **Estudiantes** de IA que buscan una herramienta práctica para experimentar con diferentes modelos
- **Profesionales** que valoran la privacidad y quieren una alternativa a interfaces centralizadas

---

## 🚀 Puntos Fuertes de la Plataforma

### 1. 🔒 Privacidad Total (Zero-Knowledge)
Toda la aplicación corre **100% en tu navegador**. No hay ningún servidor backend que almacene tus conversaciones o claves API. Tus datos son tuyos.

### 2. 📚 Código Altamente Comentado (Educativo)
El código fuente está documentado con **JSDoc extenso**, explicando:
- Cómo se construyen los payloads de request
- Cómo funcionan los diferentes formatos de respuesta (OpenAI vs Gemini)
- Cómo implementar "Tool Calling" (el modelo ejecutando funciones)

### 3. 🔌 Multi-Proveedor
Conecta con múltiples proveedores de IA desde la misma interfaz:
- **Groq** - Inferencia ultrarrápida
- **OpenRouter** - Acceso a cientos de modelos
- **OpenAI** - GPT-4o, o1, etc.
- **Google Gemini** - Los modelos de Google AI
- **xAI (Grok)** - El modelo de xAI
- **Custom** - Cualquier API compatible con OpenAI

### 4. 🛠️ Soporte MCP (Model Context Protocol)
Aprende cómo las IAs pueden ejecutar herramientas locales mediante el protocolo MCP.

---

## ⚙️ Instalación Rápida

```bash
# 1. Clonar el repositorio
git clone https://github.com/tu-usuario/nodemat-chat.git
cd nodemat-chat

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env
# Editar .env con tus claves API

# 4. Iniciar servidor de desarrollo
npm run dev
```

Abre `http://localhost:5173` en tu navegador.

---

## 🔧 Variables de Entorno

Crea un archivo `.env` en la raíz del proyecto con las siguientes variables:

### Autenticación de la App

| Variable | Descripción | Default |
| :--- | :--- | :--- |
| `VITE_ADMIN_USER` | Usuario para login | `admin` |
| `VITE_ADMIN_PASSWORD` | Contraseña para login | `admin` |

### API Keys de Proveedores

| Variable | Proveedor | Prefijo de Key | Dónde obtenerla |
| :--- | :--- | :--- | :--- |
| `VITE_GROQ_API_KEY` | Groq Cloud | `gsk_...` | [console.groq.com/keys](https://console.groq.com/keys) |
| `VITE_OPENROUTER_API_KEY` | OpenRouter | `sk-or-...` | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| `VITE_OPENAI_API_KEY` | OpenAI | `sk-...` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `VITE_CEREBRAS_API_KEY` | Cerebras | `csk-...` | [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| `VITE_GEMINI_API_KEY` | Gemini (AI Studio) | `AIza...` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `VITE_XAI_API_KEY` | xAI (Grok) | `xai-...` | [console.x.ai](https://console.x.ai) |

### Proveedores Personalizados

Para preconfigurar proveedores compatibles con OpenAI (ej: Mistral, Together AI, etc.):

| Variable | Descripción |
| :--- | :--- |
| `VITE_CUSTOM1_NAME` | Nombre visible del proveedor 1 |
| `VITE_CUSTOM1_API_KEY` | API Key del proveedor 1 |
| `VITE_CUSTOM1_API_URL` | URL base (ej: `https://api.mistral.ai/v1`) |
| `VITE_CUSTOM1_MODEL` | Modelo por defecto |
| `VITE_CUSTOM2_NAME` | Nombre visible del proveedor 2 |
| `VITE_CUSTOM2_API_KEY` | API Key del proveedor 2 |
| `VITE_CUSTOM2_API_URL` | URL base de la API |
| `VITE_CUSTOM2_MODEL` | Modelo por defecto |

### Configuración Avanzada

| Variable | Descripción |
| :--- | :--- |
| `VITE_MCP_REGISTRY_URL` | URL del registro de servidores MCP (opcional) |

---

## 📂 Estructura del Proyecto

```
nodemat-chat/
├── App.tsx              # Componente principal de la app
├── components/          # Componentes UI reutilizables
│   ├── ChatImage.tsx    # Visualización de imágenes en chat
│   ├── FileUploadModal.tsx # Modal para adjuntar archivos
│   └── SearchableSelect.tsx # Selector de modelos
├── services/
│   ├── llmService.ts    # ⭐ Orquestador de llamadas a LLM (MUY DOCUMENTADO)
│   └── storageService.ts # Persistencia en IndexedDB
└── types.ts             # Definiciones de TypeScript
```

> **💡 Tip:** Comienza leyendo `services/llmService.ts`. Es el corazón de la aplicación y está extensamente documentado con explicaciones de cómo funcionan las APIs de LLM.

---

## ⚠️ Posibles Problemas y Limitaciones

### 🔐 Seguridad de API Keys
- Las claves se guardan en el `localStorage` del navegador
- **Riesgo:** Si alguien tiene acceso a tu computadora, puede extraer las claves
- **Mitigación:** Usa navegación privada para sesiones temporales

### 🌐 Restricciones CORS
- Algunas APIs (ej: Anthropic) no permiten llamadas directas desde navegadores
- Esto es una limitación del navegador, no de Nodemat
- **Alternativa:** Usar OpenRouter como intermediario

### 📦 Límites de Almacenamiento
- IndexedDB tiene límites que varían por navegador (~50MB - varios GB)
- Conversaciones muy largas con muchas imágenes pueden alcanzar estos límites
- **Mitigación:** Exportar y borrar chats periódicamente

### 🔧 Proveedores Personalizados
- Deben ser 100% compatibles con la API de OpenAI
- No todos los proveedores implementan `/v1/models` correctamente

---

## 🛠️ Stack Tecnológico

| Categoría | Tecnología |
| :--- | :--- |
| Framework | React 19 + TypeScript |
| Build | Vite 7 |
| Estilos | Tailwind CSS |
| Iconos | Lucide React |
| Persistencia | IndexedDB (idb-keyval) |
| Markdown | react-markdown + remark-gfm |

---

## 📜 Licencia

MIT License - Libre para uso educativo y comercial.

---

**Nodemat Chat** - Aprende cómo funcionan los LLMs construyendo con ellos. 🧠💻
