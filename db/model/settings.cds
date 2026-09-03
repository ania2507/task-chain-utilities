namespace conditional.app.settings;

/**
 * Generic key/value store for small, environment-specific configuration
 * values that should be editable without a redeploy (e.g. the IBP technical
 * user that owns jobs launched via /v1/jobs/launch - one value per landscape,
 * previously hardcoded in each DSP API task's request body).
 * Purely a technical/internal table: not exposed via any OData service, only
 * read via GET /v1/settings - rows are written directly against HANA
 * (e.g. HANA Cockpit/DBeaver), so there's no created/modified by/at tracking.
 */
entity AppSetting {
  key name        : String(100) @title: 'Setting Name';
      value       : String(500) @title: 'Value';
      description : String(500) @title: 'Description';
}
