# Task Chain Utilities - Technical Documentation

## 1. Scope

Task Chain Utilities is a CAP-based application used to orchestrate and monitor task-chain executions across SAP systems.

The current architecture is based on:
- SAP CAP service (Node.js) for OData/API exposure.
- Python service (Flask) for orchestration logic and integrations.
- SAP BTP Destination Service for outbound connectivity.
- Existing HDI container ORCHESTRATOR for application persistence.

Legacy DSP direct access (CLI and direct HANA credentials) has been removed.

## 2. High-Level Architecture

### 2.1 Runtime Components

- `task-chain-utilities` (Approuter)
- `task-chain-utilities-srv` (CAP Node.js service)
- `task-chain-utilities-py-srv` (Python Flask backend)
- `task-chain-utilities-db-deployer` (HDI deployer)

### 2.2 External Services

- XSUAA for authentication and authorization.
- Destination Service for managed outbound connections.
- HDI container service instance `orchestrator_hdi_cont_noprod`.

### 2.3 Environment Variables

In Cloud Foundry, most of these are bound automatically via `mta.yaml` service bindings / `VCAP_SERVICES` and don't need to be set manually. They matter mainly for local development — see `py-srv/.env.example` for a ready-to-copy template of the Python-side ones.

**CAP service (Node.js, `srv/`)**

| Variable | Description | Default |
|---|---|---|
| `PY_SRV_URL` | Base URL of the Python Flask backend, used by `srv/schedules.js` and `srv/services.js` to call py-srv routes. Bound automatically in CF via `~{py-srv-api/py-srv-url}`. | `http://localhost:8080` |
| `NODE_ENV` | Standard Node environment flag; affects destination lookup fallback in `srv/services.js`. | unset |

**Python service (Flask, `py-srv/`)**

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port the Flask app listens on. | `8080` |
| `DEBUG` | Flask debug mode. | `false` |
| `LOG_LEVEL` | Python logging level. | `INFO` |
| `SKIP_AUTH` | Bypasses XSUAA token validation entirely. **Never set in production.** | `false` |
| `USE_IN_MEMORY_REPO` | Uses an in-memory store instead of HANA, for a quick smoke test without a DB. | `false` |
| `ENABLE_DEBUG_ENDPOINTS` | Exposes diagnostic routes (`GET /v1/dsp/debug-*`, `GET /v1/jobs/ibp/debug-conn`, `_debug_*` keys in `POST /v1/jobs/ibp/template-steps`) that leak internal metadata. Keep disabled outside local debugging. | `false` |
| `HANA_SERVICE_INSTANCE_NAME` | Name of the bound HDI container service instance for application data. | `task-chain-utilities-db` |
| `DSP_HANA_SERVICE_NAME` | Name of the bound user-provided service for DSP cross-schema HANA access. | `dsp-hana` |
| `DSP_SERVICE_NAME` | Name of the bound user-provided service for DSP credentials. | `dsp-credentials` |
| `HANA_HOST` / `HANA_PORT` / `HANA_USER` / `HANA_PASSWORD` / `HANA_SCHEMA` / `HANA_ENCRYPT` | Local-dev fallback for application HANA connection when no `HANA_SERVICE_INSTANCE_NAME` binding is available. | — |
| `DSP_HANA_HOST` / `DSP_HANA_PORT` / `DSP_HANA_USER` / `DSP_HANA_PASSWORD` | Local-dev fallback for DSP cross-schema HANA access when no `dsp-hana` UPS binding is available. | — |
| `DSP_SCHEDULES_VIEW` | Overrides the `ORCHESTRATION.3VR_*` view name used to read DSP schedules. | built-in default |
| `DSP_DESTINATION_NAME` / `SAC_DESTINATION_NAME` / `IBP_DESTINATION_NAME` | Destination Service entry names for each integration (see §5.1). | — |
| `DSP_DEST_VERIFY_SSL` / `IBP_DEST_VERIFY_SSL` | Disable TLS verification for the corresponding destination (local/self-signed only). | `true` |
| `DSP_SIMULATE` | Simulates DSP execution instead of calling the real API — for local testing. | `false` |
| `DEST_SERVICE_URL` / `DEST_TOKEN_URL` / `DEST_CLIENT_ID` / `DEST_CLIENT_SECRET` | Local-dev fallback for the Destination Service's own OAuth client, used by `dsp`/`sac`/`ibp` integrations when no `VCAP_SERVICES` destination binding is present. | — |
| `IBP_HOST` / `IBP_USER` / `IBP_PASSWORD` / `IBP_VERIFY_SSL` | Local-dev fallback for direct IBP connectivity, bypassing the Destination Service. | — |
| `SAC_HOST` / `SAC_TOKEN_URL` / `SAC_CLIENT_ID` / `SAC_CLIENT_SECRET` / `SAC_VERIFY_SSL` | Local-dev fallback for direct SAC connectivity, bypassing the Destination Service. | — |
| `VCAP_SERVICES` | Platform-injected service bindings (HANA, Destination, DSP/SAC/IBP UPS). Present automatically on CF; not set manually. | — |

### 2.4 Logical Flow

1. UI calls APIs through Approuter.
2. CAP service handles OData and delegates integration workflows to Python service when required.
3. Python service resolves destination credentials from Destination Service.
4. Python service calls external APIs (DSP/SAC/IBP) over HTTPS.
5. CAP/Python services read and write application data on HDI ORCHESTRATOR.

## 3. Repository Structure

- `app/`: UI applications (`webapp`, `skipoverrides`, `monitoring`) and approuter.
- `srv/`: CAP service models and implementation.
- `db/`: CDS data model and HANA artifacts.
- `py-srv/`: Python service, routes, integrations, repositories, executors.
- `mta.yaml`: Cloud Foundry module/resource topology and bindings.

## 4. Database Architecture

### 4.1 Current Target Container

The application uses an existing HDI container:
- CF service instance: `orchestrator_hdi_cont_noprod`
- Logical schema/container name: `ORCHESTRATOR`

`mta.yaml` binds this existing service via `org.cloudfoundry.existing-service`.

### 4.2 DB Deployer

The `task-chain-utilities-db-deployer` module deploys artifacts from `gen/db` to the existing ORCHESTRATOR container.

### 4.3 Legacy Container

The old HDI instance `task-chain-utilities-db` has been decommissioned.

## 5. Integration Architecture

### 5.1 Destination-Based Connectivity

All integrations use Destination Service. No direct DSP credentials file or DSP CLI-based execution is used.

Configured destination names in Python module properties:
- `DSP_DESTINATION_NAME=External_Trigger_DSP`
- `SAC_DESTINATION_NAME=SAC_DSP_ORCHESTRATOR`
- `IBP_DESTINATION_NAME=IBP_APPJOB_MANAGEMENT`

### 5.2 DSP Integration

DSP task-chain operations are executed via REST APIs through destination-resolved authentication.

Main DSP operations:
- launch task chain
- poll task status/log
- list spaces
- list chains by space

### 5.3 SAC Integration

SAC calls are performed through destination `SAC_DSP_ORCHESTRATOR`.

If destination auth type is OAuth2SAMLBearerAssertion, a propagated user token or `SystemUser` configuration is required to retrieve auth tokens.

### 5.4 IBP Integration

IBP operations are invoked via destination `IBP_APPJOB_MANAGEMENT`.

## 6. Security Model

- Authentication: XSUAA.
- Authorization: application role model from `xs-security.json` (admin scope/role pattern).
- Service-to-service calls use destination-managed credentials/tokens.
- No hardcoded external credentials in source code.

## 7. APIs and Service Layers

### 7.1 CAP Layer (Node.js)

- Exposes OData services under `srv/` CDS/service handlers.
- Handles UI-facing data contracts.
- Delegates specific operational workflows to Python backend where needed.

### 7.2 Python Layer (Flask)

- Provides orchestration and integration endpoints.
- Encapsulates external system clients and execution logic.
- Handles task-chain run/status workflows and integration diagnostics.

## 8. Build and Deployment

### 8.1 Local Build

```bash
npm ci
npx cds build --production
mbt build
```

### 8.2 Cloud Foundry Deploy

```bash
cf deploy mta_archives/task-chain-utilities_1.0.0.mtar
```

### 8.3 Post-Deploy Checks

```bash
cf apps
cf service orchestrator_hdi_cont_noprod
cf mta-ops
```

Expected result:
- `task-chain-utilities-srv` started
- `task-chain-utilities-py-srv` started
- `task-chain-utilities-db-deployer` stopped (normal after deploy)

## 9. Operations Runbook

### 9.1 Verify HDI Binding Target

```bash
cf service orchestrator_hdi_cont_noprod
```

Verify bound apps include:
- `task-chain-utilities-srv`
- `task-chain-utilities-py-srv`
- `task-chain-utilities-db-deployer`

### 9.2 Verify Destination Availability

Validate destination service binding and destination names in app env before testing connectivity.

### 9.3 Typical Failure Pattern: SAC Destination Token Retrieval

Error pattern:
- Cannot determine user to propagate for OAuth2SAMLBearerAssertion

Resolution options:
1. Provide a valid user token during destination retrieval (principal propagation).
2. Configure `SystemUser` in destination setup where technically and security-wise allowed.
3. If supported by scenario, use a non-user-propagation auth flow such as client credentials.

## 10. Current Technical Decisions

1. Use Destination Service as the single outbound connectivity mechanism.
2. Use existing ORCHESTRATOR HDI container as persistent store.
3. Keep CAP and Python responsibilities separated:
- CAP for service facade and UI contract.
- Python for orchestration and external integrations.
4. Remove legacy DSP direct HANA/CLI integration paths.

## 11. Business Logic Notes

### 11.1 SkipOverride — Cascade and Uniqueness (`srv/services.js`)

The four key fields form a hierarchy: `spaceId` → `taskchain` → `stepId` → `stepToBeChecked`. While editing a draft, changing a field resets every field below it to `null` (never the other way around):
- Changing `spaceId` clears `taskchain`, `stepId`, `stepToBeChecked`.
- Changing `taskchain` clears `stepId`, `stepToBeChecked`.
- Changing `stepId` clears `stepToBeChecked`.

On save (`before SAVE`), the request is rejected with a 400 if another row already exists with the same combination of all four key fields — regardless of `override`/`lastOverrideAt`, which are not part of the logical key.

### 11.2 Traffic Lights — State Machine (`TrafficLightStatus`)

Two independent fields, both on `db/model/schedules.cds` entity `TrafficLightStatus`:

- **`status`** (execution semaphore): `ready` → `running` → `completed`/`error`. `ready` is only ever set by the external system; the scheduler only launches the task chain when `status = 'ready'`. After launching it sets `running`, then always resolves to `completed`/`error` once the run finishes (never left stuck on `running`).
- **`initialState`** (Lifecycle Enable/Disable toggle, independent of the semaphore above): `GREEN` (enabled) | `RED` (disabled). Defaults to `GREEN` on creation; can be toggled manually from the Lifecycle panel in the UI; also updated by the "After each run" policy (`scheduler_service.py: _apply_after_run_policy`) once a run finishes — if `autoReset` is enabled, `initialState` is set to the configured `autoResetState` (`GREEN` or `RED`); if `autoReset` is disabled, the Traffic Lights schedule is instead deleted entirely (one-shot behavior).
- **`GREY` is not a persisted value** — it's a UI-only display state (`TrafficLightsPage.controller.js`) shown whenever `status === 'running'`, regardless of `initialState`. It means "Running", not "on hold".

### 11.3 Rule Engine Contract (`py-srv/src/engine/rule_engine.py`)

User-authored rules run as Python code inside a restricted `exec()` sandbox (allowed imports: `re`, `math`, `datetime`, `json`, `time`; `db_query()` only allows `SELECT`). Every rule **must** assign both a `spaceId` and a `taskchain` variable — this is the mandatory contract the routing engine relies on to know which task chain to launch in which DSP space.

### 11.4 `ORCHESTRATION.3VR_*` HANA Views — External Ownership

The Python layer never queries `DWC_GLOBAL.*`/`DWC_TENANT_OWNER.*` (Datasphere's own internal tables) directly. All queries go through `ORCHESTRATION.3VR_*` objects (e.g. `3VR_DWC_TASK_LOGS_01`, `3VR_DEPL_METADATA_01`) — an intermediate view layer provisioned on the Datasphere side (the "Orchestration" space), not present in this repository (no `.hdbview`/DDL here). **Ownership/maintenance of these objects on the DSP side is not documented anywhere today** — this should be clarified with whoever administers the Orchestration space before relying on them long-term.
