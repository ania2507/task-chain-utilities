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
- SAP Job Scheduling Service (`CF_JobScheduling`, standard plan) — schedules calendar entries and Traffic Lights checks with HA/multi-instance safety (see §5.5).

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
| `ENABLE_DEBUG_ENDPOINTS` | Exposes diagnostic routes/fields that leak internal metadata (raw DB rows, live schema probes) or cost extra live calls to an external system: `GET /v1/dsp/debug-*`, `GET /v1/jobs/ibp/debug-conn`, `_debug_*`/`debug` keys in `GET /v1/dsp/taskchain-schedules`, `GET /v1/dsp/taskchain-steps`, `GET /v1/dsp/task-global-vars` and `POST /v1/jobs/ibp/template-steps`, plus the SAC reconnaissance routes `GET /v1/jobs/sac/dataexport/members`, `GET /v1/jobs/sac/probe-multiaction/<id>`, `GET /v1/jobs/sac/multiaction-definition/<id>` (404 when disabled). Convention: the flag must gate the extra *work* itself (extra API calls, raw queries), not just whether the result is included in the response — see §5.6 and §10.8. Keep disabled outside local debugging. | `false` |
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
| `VCAP_SERVICES` | Platform-injected service bindings (HANA, Destination, DSP/SAC/IBP UPS, `jobscheduler`). Present automatically on CF; not set manually. | — |

The SAP Job Scheduling client (`JobSchedulerClient.from_env()`) has no dedicated local-dev env vars — it reads its credentials directly from the `jobscheduler` entry in `VCAP_SERVICES`. Locally (no CF binding) it's simply unavailable and `SchedulerService` falls back to the in-process scheduler transparently (see §5.5).

Per-landscape config values that should be editable without a redeploy (`IBP_JOB_USER`, `IBP_MAX_PARAM_COUNT`) are **not** env vars — they live in the `AppSetting` HANA table, read via `GET /v1/settings` (see §5.4, §5.6, §7.2).

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

The technical user that owns jobs launched via `POST /v1/jobs/launch` (`job_user` in the request body) is landscape-specific and no longer hardcoded in each DSP API Task: when the integration is `ibp`, `routes/jobs.py` reads it at request time from the `AppSetting` table (row `IBP_JOB_USER`, see §5.5) and injects it into the payload only if a value is found — otherwise the request proceeds without it, unchanged from the old hardcoded behavior.

### 5.5 Job Scheduling Integration

Calendar entries and Traffic Lights checks are scheduled through the SAP Job Scheduling Service (`CF_JobScheduling`, standard plan) instead of purely in-process, to avoid missed/duplicated runs when the `py-srv` app scales to multiple instances.

- `py-srv/src/integrations/jobscheduler/client.py` (`JobSchedulerClient`): OAuth2 client-credentials against the service's own XSUAA, then REST calls to create/find a Job and create/delete Schedules on it. Requires `admin` scope's `grant-as-authority-to-apps: ["$XSSERVICENAME(CF_JobScheduling)"]` in `xs-security.json` (must reference the real CF service instance name, not the MTA resource alias).
- `SchedulerService` (`py-srv/src/services/scheduler_service.py`) delegates entry/traffic-light registration to `JobSchedulerClient` when it's available (bound + `VCAP_APPLICATION.application_uris` resolvable for the callback URL); otherwise it falls back to the in-process scheduler, so local `cds watch` keeps working unchanged.
- Each Job Scheduling schedule's action calls back into this app: `POST /v1/scheduler/jobscheduler-callback` (fires the entry/traffic-light check) and `POST /v1/scheduler/jobscheduler-delete` (used to clean up a one-shot schedule after it fires, e.g. Traffic Lights with "after run" auto-reset disabled).
- `ScheduleEntry`/`Schedule` (`db/model/schedules.cds`) carry a `jobSchedulerScheduleId` used to map back to the external schedule for updates/deletes; `srv/schedules.js` hooks (`captureJobSchedulerId`, `notifyExternalDelete`) keep it in sync on UPDATE/DELETE.
- Known constraints hit during integration: job names reject hyphens (use underscores), job-creation payloads require an explicit `"schedules": []`, and the minimum schedule granularity is 5 minutes.
- The in-process 60s completion-polling loop and gunicorn's single worker (`--workers 1`, see §8) are **not** covered by this migration — a frozen/blocked polling loop remains an open residual risk by design.

### 5.6 IBP Job Template Parameter Size Guard

IBP's `JobSchedule` OData v2 Function Import (service `BC_EXT_APPJOB_MANAGEMENT;v=0002`) puts every parameter in the request URL — this is a protocol-level constraint of OData v2 Function Imports (parameters are URL query options regardless of HTTP verb; there is no body-parameter mechanism, unlike OData v4 Actions), confirmed directly against the service's own `$metadata`. IBP's gateway rejects the URL above **~64,700–64,900 characters** (measured empirically), and testing showed IBP does **not** reliably honor a partial parameter override — only sending *all* parameters or *none* works correctly.

To avoid ever hitting that limit, `routes/jobs.py` (`_ibp_template_param_stats`, `_get_ibp_max_param_count`) computes each template's real parameter count and estimated URL length, against a threshold read from `AppSetting` (`IBP_MAX_PARAM_COUNT`, default **200** — a safety margin under the ~337-parameter theoretical max at the ~192 chars/param average observed on real templates):

- **Under threshold**: unchanged behavior — the Step Parameters UI's "Usa Default" toggle is the user's free choice; custom parameters are sent normally.
- **Over threshold**: "Usa Default" is forced on and locked (parameter editing disabled) both in the UI and at save time (`onSave`'s hard gate in `StepParametersPage.controller.js`) and at launch time (`POST /v1/jobs/launch`'s own gate, defense-in-depth against stale/bypassed state) — the job always launches with zero custom parameters, so IBP uses its own saved template defaults. The same rule is enforced on the Excel Custom Calendar import (`CustomCalendarPage.controller.js`'s `_checkIbpParamLimitsForImport`), where the "Job Template" column is mandatory for IBP-typed rows.

The "Usa Default" flag and the lock state are properties of the **job template**, not of any one DSP step occurrence — if the same template is referenced by more than one step in a chain, toggling it (or hitting the size lock) on one occurrence is mirrored onto every other step using that same template (`_applyIbpParamSizeGuard`).

The job name IBP shows in its own job history (`JobText`) can optionally be customized per step via the same Step Parameters UI (pre-filled with the template's own description, editable) — persisted as the `__ibpJobTextOverride` sentinel and honored by `IBPJobClient.launch_job`'s `job_text` param when non-blank, otherwise auto-derived from the template description as before.

### 5.7 Concurrent-Launch Guards — Two Independent Mechanisms, Kept in Sync

Two separate in-memory mechanisms both track "is this task chain currently running", for different reasons:

1. **`SchedulerService._running_taskchains` / `_pending_queue`** (`scheduler_service.py`): a per-`(spaceId, taskchain)` FIFO queue. A scheduled/manual fire for a taskchain that's already running is queued (persisted as a `ScheduleRun` row with `status: "queued"`) instead of launched immediately, and dequeued once the running execution reaches a terminal DSP status (`_check_taskchain_completion`, polled every 60s).
2. **`TaskchainExecutor._ACTIVE_TASKCHAINS`** (`taskchain_executor.py`): a per-taskchain-name reservation with a 3-hour safety-net expiry (`_ACTIVE_TASKCHAIN_MAX_SECONDS`), used by `execute_async_dsp`/`retry_dsp` to hard-reject a second concurrent launch that would otherwise overwrite the first run's still-in-use stored step parameters (`_PENDING_STEP_PARAMS` is keyed only by taskchain name — DSP gives no per-run identity on the step-launch callback). Released by its own background poller (`_watch_taskchain_active_flag`, ~30s interval) once DSP reports a terminal status.

Because these poll independently, they can fall out of sync: a queued fire (#1) can be ready to dequeue while guard #2 hasn't yet noticed the same execution finished, causing the dequeued relaunch to fail immediately with *"Task chain '...' is already running..."* — the queued entry never actually starts, silently, until #2's own poller (or its 3h safety net) eventually catches up. Fixed by having `_check_taskchain_completion` (mechanism #1), once it has the authoritative "this execution is over" signal, also proactively clear the matching entry in `_ACTIVE_TASKCHAINS` (mechanism #2) before dequeuing the next fire, instead of waiting on mechanism #2's own independent poll. Any future change to either mechanism's completion-detection should preserve this cross-clear to avoid reintroducing the same class of bug.

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
- `GET /v1/settings` (`routes/settings.py`, `admin` scope): read-only listing of the `AppSetting` table (`name`, `value`, `description`) — rows are written directly against HANA, not through this app (see §5.4, §5.5).
- `POST /v1/jobs/ibp/template-steps` (`routes/jobs.py`, `admin` scope): reads an IBP template's step/parameter structure and returns the size-guard verdict (`paramCount`, `maxParamCount`, `tooManyParams`) used by the Step Parameters UI and the Excel import check — see §5.6.
- `GET /v1/scheduler/active-taskchains` / `DELETE /v1/scheduler/active-taskchains/<taskchain>` (`routes/scheduler.py`, `admin` scope): inspect/manually clear the `_ACTIVE_TASKCHAINS` guard described in §5.7 — useful to diagnose or unblock a launch rejected as "already running".
- `POST /v1/scheduler/jobscheduler-callback` / `POST /v1/scheduler/jobscheduler-delete` (`routes/scheduler.py`): callback targets invoked by the Job Scheduling Service itself, not meant for direct/manual use (see §5.5).

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

`py-srv` runs under gunicorn in every environment (`Procfile` / `mta.yaml` module `command`: `gunicorn --workers 1 --bind 0.0.0.0:$PORT app:app`), not Flask's own dev server — a single worker is used because completion-polling and in-process fallback scheduling rely on shared in-memory state (see §5.5).

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
5. Delegate entry/Traffic-Lights scheduling to the SAP Job Scheduling Service for HA/multi-instance safety, with a transparent fallback to in-process scheduling when the service isn't bound (local dev) — see §5.5.
6. Store small per-landscape config values that should be editable without a redeploy (e.g. `IBP_JOB_USER`, `IBP_MAX_PARAM_COUNT`) in the generic `AppSetting` HANA table instead of env vars — see §5.4, §5.6.
7. IBP job launches never send a parameter set that could exceed IBP's gateway URL-length limit — templates over threshold always launch with zero custom parameters instead, rather than risking a `414` (see §5.6). This is enforced redundantly in the UI, at save time, and at launch time.
8. A debug/diagnostic code path (extra API calls, raw DB dumps, reconnaissance probes) must be gated by `ENABLE_DEBUG_ENDPOINTS` **before** doing the extra work, not just before including it in the response — gating only the response field still pays the cost (extra live calls, DB load) on every normal request (see §2.3).

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
- **`initialState`** (Lifecycle Enable/Disable toggle, independent of the semaphore above): `GREEN` (enabled) | `RED` (disabled). Defaults to `GREEN` on creation; can be toggled manually from the Lifecycle panel in the UI; also updated by the "After each run" policy (`scheduler_service.py: _apply_after_run_policy`) once a run finishes — if `autoReset` is enabled, `initialState` is set to the configured `autoResetState` (`GREEN` or `RED`); if `autoReset` is disabled, the Traffic Lights schedule is instead deleted entirely (one-shot behavior). When the schedule was registered on the Job Scheduling Service (§5.5), this deletion path also looks up and deletes the corresponding external schedule (`delete_external_schedule`) before removing the DB row — skipping this would otherwise leave an orphaned recurring schedule still firing every 5 minutes.
- **`GREY` is not a persisted value** — it's a UI-only display state (`TrafficLightsPage.controller.js`) shown whenever `status === 'running'`, regardless of `initialState`. It means "Running", not "on hold".

### 11.3 Rule Engine Contract (`py-srv/src/engine/rule_engine.py`)

User-authored rules run as Python code inside a restricted `exec()` sandbox (allowed imports: `re`, `math`, `datetime`, `json`, `time`; `db_query()` only allows `SELECT`). Every rule **must** assign both a `spaceId` and a `taskchain` variable — this is the mandatory contract the routing engine relies on to know which task chain to launch in which DSP space.

### 11.4 `ORCHESTRATION.3VR_*` HANA Views — External Ownership

The Python layer never queries `DWC_GLOBAL.*`/`DWC_TENANT_OWNER.*` (Datasphere's own internal tables) directly. All queries go through `ORCHESTRATION.3VR_*` objects (e.g. `3VR_DWC_TASK_LOGS_01`, `3VR_DEPL_METADATA_01`) — an intermediate view layer provisioned on the Datasphere side (the "Orchestration" space), not present in this repository (no `.hdbview`/DDL here). **Ownership/maintenance of these objects on the DSP side is not documented anywhere today** — this should be clarified with whoever administers the Orchestration space before relying on them long-term.
