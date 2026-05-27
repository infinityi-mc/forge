# 🛠️ Forge

**The boring infrastructure layer your business logic deserves.**

[![Bun Version](https://img.shields.io/badge/bun-1.3%2B-orange.svg)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0.3%2B-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 🎯 Project Goal

Most production applications stand on the same eight infrastructure pillars. Yet, most teams reinvent them—usually poorly, under time pressure, and without realizing they are solving already-solved problems.

**Forge** exists to eliminate the "infrastructure tax." It is an opinionated, composable toolkit that handles the heavy lifting of distributed systems so your team can spend time on *what* the app does (business value), rather than *how it survives* (infrastructure). 

Forge makes the right way the easy way.

---

## ⚡ Tech Stack

Forge is unapologetically built for modern, high-performance backend development.

*   **TypeScript (Strict Mode):** Every module is heavily typed. Configurations are inferred, database queries are type-checked, and resilience policies are strictly validated at compile time.
*   **Bun Runtime:** Forge is **Bun-first**. We leverage Bun's native TypeScript execution, blazing-fast startup times, built-in test runner, and native APIs (like `bun:sqlite` for lightweight outbox/job queues) to keep overhead near zero. 

### Why Bun?
Node.js served us well, but modern backends need faster feedback loops and lower memory footprints. Bun provides native TS execution without transpilation overhead, a Jest-compatible test runner that runs in milliseconds, and a bundler that makes deploying single-binary serverless functions trivial.

---

## 📦 Core Modules

Forge is modular. Import only what you need; tree-shaking ensures zero bloat.

| Module | Purpose |
| :--- | :--- |
| **`forge/telemetry`** | Structured logging, distributed tracing, and metrics (Prometheus/OTLP) with automatic context propagation. |
| **`forge/resilience`** | Composable decorators for `retry`, `timeout`, `circuitBreaker`, `bulkhead`, and `rateLimit`. |
| **`forge/config`** | Schema-validated, fail-fast configuration and secrets management. Typed access, redacted logging. |
| **`forge/data`** | Connection pooling, Unit of Work (transactions), type-safe query building, and migration tooling. |
| **`forge/messaging`** | Transactional Outbox pattern, idempotent consumers, Dead Letter Queues (DLQ), and background jobs. |
| **`forge/http`** | Resilient HTTP client, server middleware stack, OpenAPI generation, and RFC 7807 Problem Details. |
| **`forge/security`** | JWT/JWKS validation, declarative AuthZ middleware, and automated audit logging. |
| **`forge/lifecycle`** | Graceful shutdown orchestration, dependency health probes (liveness/readiness), and signal handling. |

---

## 🧠 Design Principles

1.  **Bun First:** Leverage Bun's native APIs instead of reinventing them. Use `Bun.serve()` for HTTP servers, Bun's built-in `fetch` for HTTP requests, `bun:sqlite` for lightweight persistence, and `bun:test` for testing. If Bun already provides a capability—don't wrap it, don't polyfill it, don't replace it with a third-party library. Forge extends Bun; it doesn't abstract it away.
2.  **Composable, Not Monolithic:** Use `forge/resilience` without `forge/data`. There are no forced peer dependencies.
3.  **Interfaces First:** Every module exposes an interface (`Logger`, `Cache`, `MessageBus`) with real and in-memory implementations. Testability is a first-class feature.
4.  **Observable by Default:** Every operation emits metrics and traces unless explicitly silenced. You cannot fix what you cannot see.
5.  **Fail-Fast at Boot:** Misconfigurations and missing secrets crash the app in milliseconds during startup, not 3 hours later in production.
6.  **Zero Magic:** No hidden control flow, no global state, no decorator-based dependency injection containers. Explicit wiring only.

---

## 🚧 Constraints (What Forge is NOT)

A good library knows its boundaries. To keep Forge lean and focused, we explicitly **do not** build:

*   ❌ **A UI/Frontend Framework:** Forge is strictly for backend/server-side infrastructure.
*   ❌ **A Domain Modeler:** We do not enforce DDD, CQRS, or Event Sourcing. Your business entities are your own.
*   ❌ **A Heavy ORM:** No identity maps, no lazy-loading proxies, no hidden N+1 queries. We provide a type-safe query builder and raw SQL execution.
*   ❌ **A Workflow/BPMN Engine:** For complex, long-running state machines, use dedicated tools like Temporal or Inngest.
*   ❌ **A Service Mesh:** We handle application-level resilience. Network-level mTLS and routing should be handled by your infrastructure (e.g., Kubernetes, Istio).

---

## 🚀 Quick Start

### Installation

```bash
bun add forge
```

### Bootstrapping an App

```typescript
import { forge } from 'forge/lifecycle';
import { config } from './config';
import { db } from './data';
import { app } from './http';

// 1. Define your components
const components = [db, app];

// 2. Boot the application
const server = await forge.boot({
  config,
  components,
  shutdownTimeout: 30_000, // Graceful shutdown window
});

server.logger.info('Forge application started', { 
  port: config.http.port 
});
```

### Running Tests

Forge ships with in-memory doubles for all core interfaces, making unit testing with Bun's native test runner effortless:

```typescript
import { describe, it, expect } from 'bun:test';
import { InMemoryMessageBus } from 'forge/messaging/testing';

describe('Order Service', () => {
  it('publishes an event when an order is placed', async () => {
    const bus = new InMemoryMessageBus();
    // ... inject bus into service and execute business logic ...
    
    expect(bus.publishedEvents).toContainEqual({
      type: 'OrderPlaced',
      payload: { orderId: '123' }
    });
  });
});
```

Run tests at lightning speed:
```bash
bun test
```

---

## 🤝 Contributing

We welcome contributions! Please read our [Contributing Guide](./CONTRIBUTING.md) to get started. 

**Development Setup:**
```bash
git clone https://github.com/your-org/forge.git
cd forge
bun install
bun run build
bun test
```

## 📄 License

Forge is open-source software licensed under the [MIT License](./LICENSE).
