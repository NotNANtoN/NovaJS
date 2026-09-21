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

### A. Pure ECMAScript Modules (ESM) Migration (Completed)
* **Status**: **Completed & Verified**
* **Changes**:
  - Set `"type": "module"` in `package.json`.
  - Configured `tsconfig.json` with `"target": "es2022"`, `"module": "esnext"`, and `"moduleResolution": "bundler"`.
  - Configured `scripts/build.mjs` for native ESM output (`format: "esm"`) with Node 24 ESM shims.
  - Migrated `scripts/test.mjs` and `scripts/run_one_test.mjs` to native ESM with dynamic `import()`.
  - Isolated CommonJS WASM artifact in `nova_wasm/pkg/package.json` (`{"type": "commonjs"}`) to eliminate all bundler warnings.
  - Upgraded pure-ESM packages:
    - `uuid` from `9.0.1` to **`14.0.2`** (and `@types/uuid` to `11.0.0`).
    - `rbush` from `3.0.1` to **`4.0.1`** (and `@types/rbush` to `4.0.0`).
    - `p-queue` from `7.4.1` to **`9.3.3`**.
    - `esbuild-visualizer` to **`0.7.0`**.
    - `@types/sat` to **`0.0.35`**, `lamejs` to **`1.2.1`**.
  - All 183 test suites pass with 0 failures; typecheck passes with 0 errors.

### B. Express 5 Upgrade (Completed)
* **Status**: **Completed & Verified**
* **Changes**:
  - Upgraded `express` to **`5.2.1`** and `@types/express` to **`5.0.6`**.
  - Updated `setupRoutes.ts` parameter handling to cleanly unwrap Express 5's array-capable route parameter types (`string | string[]`).
  - Verified all major endpoints (`/`, `/gameData/ids.json`, `/gameData/data/System/nova:148.json`, `/gameData/data/Planet/nova:128.json`, `/api/galaxy/pilots`) return 200 OK.
  - Native promise rejection handling active in server route handlers.
  - `bun run typecheck` passes with 0 errors; all 183 test suites pass.

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
| **Module Format** | Native ESM (`"type": "module"`, `"moduleResolution": "bundler"`) | Native ESM |
| **HTTP Server** | Express 5.2.1 | Express 5.2.1 |
| **State Proxy** | Immer 9.0.21 | Immer 11.x |
| **PixiJS** | PixiJS 8.21.0 | Latest v8 |
| **Typecheck** | 0 errors | 0 errors |
| **Test Suite** | 183 / 183 passing | 100% passing |
