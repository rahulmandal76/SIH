# Deployment & Environment Specification

## 1. Local Development Architecture

- **Operating System**: Windows / Linux / macOS.
- **Node.js**: v22.14+ / npm 10.9+.
- **Python**: v3.13.3+ (Virtual environment `.venv`).
- **Database**: SQLite (via Prisma ORM, zero system installer dependency) using `prisma/schema.sqlite.prisma` or local development target.
- **Orchestration**: Single command from repository root:
  ```bash
  npm run dev:all
  ```
  Starts Vite (:5173), Express Gateway (:5000), and FastAPI RAG service (:8000).

---

## 2. Production Cloud Architecture

- **Web Tier**: Static React SPA deployed to CDN / Vercel / NGINX reverse proxy.
- **Gateway Tier**: Node.js Express cluster (Docker containerized) with TLS 1.3 termination.
- **RAG Tier**: Python FastAPI microservice (Docker containerized, Gunicorn + Uvicorn workers).
- **Canonical Database**: Managed PostgreSQL (AWS RDS / Supabase / Neon) with connection pooling.
- **Session Tier**: Distributed Redis / Valkey cluster for session persistence and distributed invalidation.
- **Storage Tier**: S3-compatible encrypted object storage for patient uploaded documents.
- **Vector Storage**: Patient-partitioned persistent volume mounted to the RAG service container.

---

## 3. Session Store Architecture: Local vs. Production

| Dimension | Local Development | Production Target |
|---|---|---|
| **Mechanism** | In-process `Map` in Node.js heap | Distributed Redis / Valkey or Managed Session DB |
| **Persistence** | Resets upon server restart | Durable across multi-instance rolling deployments |
| **Horizontal Scaling** | Single instance only | Multi-instance load-balanced across API Gateway replicas |
| **Session Invalidation** | In-process map deletion | Instant broadcast/eviction across all gateway nodes via Redis pub/sub |
| **Security Status** | Functional for local validation | **MANDATORY for production deployment** |

> **Production Rule**: In-memory sessions are strictly an engineering convenience for local offline development. Production readiness requires Redis session persistence before live multi-instance deployment.

---

## 4. Cookie & CSRF Configuration by Deployment Topology

To ensure security across development and production, cookie flags and anti-CSRF measures must strictly align with the operational network topology:

| Topology Scenario | Architecture | Cookie Flags | CSRF Defense Mechanism |
|---|---|---|---|
| **Local Development** | Vite frontend (:5173) calling Node backend (:5000) directly or via Vite dev proxy | `HttpOnly; SameSite=Lax; Path=/` (`Secure=false` on plain HTTP) | `X-Requested-With: XMLHttpRequest` custom AJAX header + Origin/Referer check matching `localhost:5173` |
| **Unified Production (Reverse Proxy)** | NGINX / Cloudflare routing both frontend (`/`) and API (`/api`) under single origin (e.g. `https://medsync.hospital.gov.in`) | `HttpOnly; Secure; SameSite=Strict; Path=/` | `SameSite=Strict` completely prevents browser from sending cookies on cross-origin requests + Origin header verification |
| **Separated Production (Subdomains)** | Frontend on `https://app.hospital.gov.in` and API on `https://api.hospital.gov.in` | `HttpOnly; Secure; SameSite=Lax; Domain=.hospital.gov.in; Path=/` | Mandatory custom AJAX header (`X-Requested-With`) + cryptographic anti-CSRF double-submit token + explicit CORS allowed origins |

### Rationale & Security Invariants:
1. **Never Hardcode `SameSite=Strict` Unconditionally**: If a development environment or cross-port staging uses cross-origin calls without a reverse proxy, `SameSite=Strict` will block necessary cookies. Instead, make `SameSite` environment-configurable (`COOKIE_SAMESITE=Lax` for local dev, `Strict` for unified production).
2. **`HttpOnly` Invariant**: Always enforced across all environments. JavaScript `document.cookie` can never read session identifiers.
3. **State-Changing Verification**: All `POST`, `PUT`, `PATCH`, `DELETE` routes enforce `csrfProtectionMiddleware` requiring valid origin and custom header verification.

