# ClientLens — Sales Copilot Chrome Extension

> Built for ZopNight's sales team. Internal-use only.

An AI-powered Chrome extension that helps sales reps generate personalized pitches, handle live meetings with a real-time copilot, and manage objections — all from the browser sidebar.

---

## Quick Start for Collaborators

### 1. Clone & install

```bash
git clone https://github.com/avinashdotcom/chrome-extension-for-sales-team.git
cd chrome-extension-for-sales-team
```

### 2. Set up the extension (frontend)

```bash
cd extension
npm install
cp .env.example .env.local   # then fill in your keys (see below)
npm run dev                  # starts Vite in watch mode
npm run build                # production build → extension/dist/
```

Load the extension in Chrome:
1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/dist/` folder

### 3. Set up the backend (Python / FastAPI)

```bash
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill in your keys
uvicorn main:app --reload
```

Backend runs at `http://localhost:8000` by default.

---

## Environment Variables

### Extension (`extension/.env.local`)

Copy `extension/.env.example` → `extension/.env.local` and fill in:

| Variable | Required | Description |
|---|---|---|
| `VITE_MOCK_MODE` | No | Set `true` to skip LLM calls (for pure UI dev) |
| `VITE_LLM_PROVIDER` | Yes | `gemini` / `groq` / `anthropic` / `custom` |
| `VITE_GEMINI_API_KEY` | If using Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — free tier |
| `VITE_GROQ_API_KEY` | If using Groq | [console.groq.com/keys](https://console.groq.com/keys) — free, very fast |
| `VITE_ANTHROPIC_API_KEY` | If using Anthropic | [console.anthropic.com](https://console.anthropic.com) — paid, best quality |
| `VITE_BACKEND_URL` | For backend features | Default: `http://localhost:8000` |
| `VITE_SUPABASE_URL` | For auth/DB features | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | For auth/DB features | Your Supabase anon key |

> `.env.local` is gitignored — keys never leave your machine.

### Backend (`backend/.env`)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic key for backend agents |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (admin access) |
| `PINECONE_API_KEY` | Pinecone for RAG vector store |
| `PINECONE_INDEX` | Pinecone index name |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `ALLOWED_ORIGINS` | CORS: `chrome-extension://YOUR_EXTENSION_ID` |

---

## Project Structure

```
chrome-extension-for-sales-team/
├── extension/                      # Chrome Extension (React + TypeScript + Vite)
│   ├── manifest.json               # MV3 manifest
│   ├── .env.example                # Template for local env vars
│   ├── src/
│   │   ├── background/             # Service worker + bg orchestrator
│   │   ├── content/                # Content script (page context capture)
│   │   ├── offscreen/              # Offscreen document (audio capture)
│   │   ├── popup/                  # Extension popup (minimal)
│   │   ├── sidebar/                # Main UI (React components + Zustand stores)
│   │   │   ├── components/         # All UI panels and cards
│   │   │   ├── hooks/              # Custom React hooks
│   │   │   └── stores/             # App state (Zustand)
│   │   ├── meeting-copilot/        # Live meeting feature
│   │   │   ├── agents/             # Live coaching agents + post-call summary
│   │   │   ├── stt/                # Speech-to-text (Deepgram + mock)
│   │   │   └── integrations/       # Google Calendar, Zoho CRM connectors
│   │   └── shared/
│   │       ├── agents/             # LLM client, council agents, model catalog
│   │       ├── auth/               # Google SSO + team config
│   │       ├── constants/          # ICP profiles
│   │       └── utils/              # Storage, KB indexer, vector store, etc.
│   └── icons/                      # Extension icons
│
├── backend/                        # FastAPI backend (Python 3.11)
│   ├── main.py                     # App entry point
│   ├── config.py                   # Config / env loading
│   ├── models.py                   # Pydantic models
│   ├── requirements.txt
│   ├── agents/                     # Multi-agent pipeline
│   │   ├── orchestrator.py         # Coordinates all agents
│   │   ├── retrieval_agent.py      # RAG retrieval
│   │   ├── brand_compliance_agent.py
│   │   ├── icp_personalization_agent.py
│   │   └── validation_agent.py
│   ├── rag/                        # RAG pipeline (Pinecone + embeddings)
│   ├── rbac/                       # Role-based access control
│   ├── api/
│   │   ├── routes/                 # generate, auth, admin, assets
│   │   └── middleware/             # JWT auth middleware
│   └── db/
│       ├── supabase_client.py
│       └── migrations/             # SQL schema migrations
│
├── design/
│   └── tokens.css                  # Design system tokens (colors, typography)
│
└── shared/
    └── types/                      # Shared TypeScript types
```

---

## System Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    CHROME EXTENSION (Frontend)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │  Sidebar UI  │  │Content Script│  │  Background Worker    │ │
│  │  (React/TS)  │  │(Page Context)│  │  (API Orchestration)  │ │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬────────────┘ │
└─────────┼────────────────┼──────────────────────┼──────────────┘
          │                │                      │
          └────────────────┼──────────────────────┘
                           │ HTTPS / WebSocket
                           ▼
┌────────────────────────────────────────────────────────────────┐
│                    BACKEND (FastAPI + Python)                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              MULTI-AGENT ORCHESTRATOR                   │   │
│  │  Agent 1: RAG/Retrieval → Agent 2: Brand Compliance     │   │
│  │  Agent 3: ICP Personalization → Agent 4: Validation     │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────┐      │
│  │  RAG Pipeline│  │ Document Generator│  │  RBAC Engine │      │
│  │  (Pinecone)  │  │  (Slides / PDF)  │  │  (Supabase)  │      │
│  └──────────────┘  └──────────────────┘  └──────────────┘      │
└────────────────────────────────────────────────────────────────┘
          │                    │                    │
   ┌──────▼──────┐    ┌────────▼────────┐  ┌──────▼──────┐
   │  Pinecone   │    │  Google Slides  │  │  Supabase   │
   │  Vector DB  │    │  / Drive API    │  │  (DB + Auth)│
   └─────────────┘    └─────────────────┘  └─────────────┘
```

---

## Key Features

### Pitch Generation
- Enter a company name → extension auto-detects context from the current tab
- Select an ICP role (CFO, CTO, VP Sales, etc.)
- Multi-agent pipeline generates a personalized pitch deck / one-pager / email

### Meeting Copilot (Live Mode)
- Captures audio from the browser tab (Google Meet / Zoom via offscreen API)
- Real-time STT via Deepgram (or mock STT in dev mode)
- Live coaching agents surface relevant talking points, competitive angles, and objection responses as the call progresses
- Post-call summary with CRM push (Zoho) and calendar sync (Google Calendar)

### Objection Handling Council
- Council of specialized agents each contribute a perspective
- Produces a ranked, structured response set in seconds

### ICP Profiles

| Profile | Content Focus |
|---|---|
| CFO | Metrics-first, ROI blocks, payback period |
| CTO | Architecture depth, security, integration surface |
| VP Sales | Competitive differentiation, case studies, social proof |
| General | Balanced, high-level |

### Knowledge Base & RAG
- Sales rep or admin uploads docs (case studies, battle cards, brand guides) into the extension KB
- Content is chunked and indexed in a local vector store (or Pinecone for backend mode)
- All pitch generation draws from this indexed knowledge

### Roles & RBAC

| Role | What they can do |
|---|---|
| **Designer** | Upload/update Design System, manage templates |
| **PMM** | Update Brand Voice & Tone, manage messaging framework |
| **Sales Rep** | Generate pitches, use meeting copilot, access all content |
| **Admin** | Full access including user management and data wipe |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Extension UI | React 18, TypeScript, Tailwind CSS, Zustand |
| Extension Runtime | Chrome Manifest V3, Service Worker, Offscreen API |
| Backend Framework | FastAPI (Python 3.11) |
| AI / Agents | Claude claude-sonnet-4-6 (Anthropic), Gemini, Groq (Llama 3.3 70B) |
| RAG / Vector Store | Pinecone + in-browser vector store (local KB) |
| Database + Auth | Supabase (Postgres + Row Level Security) |
| Speech-to-Text | Deepgram Nova-2 (real-time streaming) |
| Document Generation | Google Slides API, Google Drive API |
| Deployment | Railway / Render (backend), Chrome Web Store (extension) |

---

## Local Dev Tips

**Mock mode** — Set `VITE_MOCK_MODE=true` in `.env.local` to develop the UI without burning LLM credits. All agent calls return canned responses.

**Workspace gating** — The extension restricts sign-in to a specific Google Workspace domain, configured in `extension/src/shared/auth/team-config.ts`. Change `ALLOWED_EMAIL_DOMAIN` to your domain for local testing.

**Admin passcode** — The Settings panel is protected by an admin passcode (SHA-256 hashed, stored in localStorage). Set one from the Settings → Admin tab after loading the extension.

**Google OAuth** — Replace `"client_id": "YOUR_GOOGLE_CLIENT_ID"` in `extension/manifest.json` with a real OAuth 2.0 Client ID (Application type: Chrome Extension) from Google Cloud Console to enable sign-in locally.
