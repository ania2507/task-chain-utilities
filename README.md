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

### 2.3 Logical Flow

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
