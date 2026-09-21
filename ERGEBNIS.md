# ERGEBNIS.md — Architecture, Modernization & Engineering Philosophy

---

## 1. Core Engineering Philosophy: "Code is Cheap"

> **"Just because it takes effort in coding and testing, never be lazy. Always go for the more advanced, better solution. Code is cheap."**

With modern AI-assisted software engineering, the traditional calculus of technical debt has inverted:
- **Mechanical refactoring is near-zero cost**: Tedious, repo-wide changes (e.g. migrating 200+ files to explicit `.js` ESM imports, modernizing route declarations, adapting proxy lifecycle APIs) can be drafted, verified, and stabilized in minutes rather than days.
- **Never settle for legacy inertia**: Avoid keeping legacy formats (like CommonJS or deprecated framework majors) simply because "it works and refactoring takes effort." Proactively modernize the codebase to the cleanest, most capable standards.
- **Aggressive verification over fear of breaking**: Code quickly, but verify relentlessly with comprehensive unit tests, strict typechecking (`bun run typecheck` with 0 errors), end-to-end flight scenarios, and automated CI/CD validation.

---

## 2. Modernization Roadmap

### A. Pure ECMAScript Modules (ESM) Migration
* **Objective**: Transition NovaJS from hybrid CommonJS (`"module": "commonjs"`) to native ESM (`"type": "module"`).
* **Benefits**:
  - Full compatibility with modern pure-ESM packages (`uuid@11+`, `p-queue@8+`, `rbush@4+`).
  - Standardized `import.meta.url` across both runtime and tools.
  - Native browser and Node alignment without dual-package workarounds.
* **Execution Steps**:
  1. Set `"type": "module"` in `package.json`.
  2. Update `tsconfig.json` to `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`.
  3. Add explicit `.js` extensions across all internal TypeScript module imports.
  4. Migrate `scripts/run_one_test.cjs` and auxiliary scripts to native ESM (`.mjs` / `.js`).
  5. Upgrade `uuid`, `rbush`, and `p-queue` to their latest major releases.
  6. Run `bun run typecheck` and `bun scripts/test.mjs` (183/183 passing).

### B. Express 5 Upgrade
* **Objective**: Upgrade from Express `4.22.3` to Express `5.2.1`.
* **Benefits**:
  - Native promise rejection handling: async route handlers (`app.get(..., async (req, res) => { ... })`) automatically propagate thrown errors to the error middleware without requiring boilerplate `.catch(next)`.
  - Upgraded router engine and HTTP header processing.
* **Execution Steps**:
  1. Upgrade `express` to `^5.2.1` and `@types/express` to `^5.0.0`.
  2. Audit `nova/src/server/setupRoutes.ts` and `http_limiter.ts` for route path regex changes (`path-to-regexp@8` syntax for splat/wildcard paths).
  3. Verify all asset endpoints (`/gameData/data/...`, `/gameData/ids.json`, `/player/...`, WebSockets) return 200 OK.
  4. Run `setupRoutes_test.ts` and `http_limiter_test.ts`.

### C. Immer 11 Upgrade & NovaECS State Hardening
* **Objective**: Upgrade from Immer `9.0.21` to Immer `11.x`.
* **Benefits**:
  - Reduced bundle size and faster proxy traps.
  - Tighter TypeScript inference for readonly state trees.
* **Execution Steps**:
  1. Upgrade `immer` to `^11.1.0`.
  2. Audit NovaECS draft boundaries (`plainSnapshot`, `deImmerify`, and `createDraft`).
  3. Verify that draft proxies are detached before asynchronous steps resume.
  4. Run the complete ECS and gameplay test suite (`async_system_test.ts`, `mission_plugin_test.ts`, `player_state_test.ts`, `jump_plugin_test.ts`).

---

## 3. Current Stable Baseline (September 2026)

| Component | Current State | Target State |
| :--- | :--- | :--- |
| **Node.js** | Node 24 (Active LTS "Krypton") | Node 24+ LTS |
| **Bun** | 1.4.2 | 1.4.2+ |
| **GitHub Actions** | Checkout v7, Setup-Node v7, Setup-Bun v2.2, Buildx v4.4, Login v4.6, Build-Push v7.4 | Keep pin-to-latest |
| **Module Format** | CommonJS (`tsconfig` cjs) | Pure ESM (`NodeNext`) |
| **HTTP Server** | Express 4.22.3 | Express 5.2.1 |
| **State Proxy** | Immer 9.0.21 | Immer 11.x |
| **PixiJS** | PixiJS 8.21.0 | Latest v8 |
| **Typecheck** | 0 errors | 0 errors |
| **Test Suite** | 183 / 183 passing | 100% passing |
