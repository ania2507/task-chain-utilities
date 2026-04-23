using Services from '../../../srv/services.cds';

// ============================================================================
// Monitoring Project Annotations
// ============================================================================

annotate Services.MonitoringProject with @(
    UI: {
        HeaderInfo: {
            TypeName: 'Monitoring Project',
            TypeNamePlural: 'Monitoring Projects',
            Title: { Value: name },
            Description: { Value: description }
        },
        SelectionFields: [ name, status ],
        LineItem: [
            { Value: name, Label: 'Project Name' },
            { Value: description, Label: 'Description' },
            { Value: status, Label: 'Status' },
            { Value: slaTarget, Label: 'SLA Target (%)' }
        ],
        Facets: [
            {
                $Type: 'UI.ReferenceFacet',
                Label: 'General Information',
                Target: '@UI.FieldGroup#General'
            },
            {
                $Type: 'UI.ReferenceFacet',
                Label: 'Task Chains',
                Target: 'taskChains/@UI.LineItem'
            },
            {
                $Type: 'UI.ReferenceFacet',
                Label: 'Alerts',
                Target: 'alerts/@UI.LineItem'
            }
        ],
        FieldGroup#General: {
            Data: [
                { Value: name },
                { Value: description },
                { Value: status },
                { Value: slaTarget },
                { Value: alertThreshold }
            ]
        }
    }
);

// ============================================================================
// Monitoring Task Chain Annotations
// ============================================================================

annotate Services.MonitoringTaskChain with @(
    UI: {
        HeaderInfo: {
            TypeName: 'Task Chain',
            TypeNamePlural: 'Task Chains',
            Title: { Value: chainName },
            Description: { Value: description }
        },
        LineItem: [
            { Value: chainName, Label: 'Chain Name' },
            { Value: spaceId, Label: 'Space ID' },
            { Value: version, Label: 'Version' },
            { Value: status, Label: 'Status' },
            { Value: slaTarget, Label: 'SLA Target' }
        ],
        Facets: [
            {
                $Type: 'UI.ReferenceFacet',
                Label: 'General',
                Target: '@UI.FieldGroup#ChainGeneral'
            },
            {
                $Type: 'UI.ReferenceFacet',
                Label: 'Executions',
                Target: 'executions/@UI.LineItem'
            }
        ],
        FieldGroup#ChainGeneral: {
            Data: [
                { Value: chainName },
                { Value: spaceId },
                { Value: description },
                { Value: version },
                { Value: status },
                { Value: slaTarget }
            ]
        }
    }
);

// ============================================================================
// Task Execution Annotations
// ============================================================================

annotate Services.TaskExecution with @(
    UI: {
        HeaderInfo: {
            TypeName: 'Execution',
            TypeNamePlural: 'Executions',
            Title: { Value: runId }
        },
        LineItem: [
            { Value: runId, Label: 'Run ID' },
            { Value: taskName, Label: 'Task' },
            { Value: status, Label: 'Status' },
            { Value: startTimestamp, Label: 'Start' },
            { Value: duration, Label: 'Duration (s)' },
            { Value: retryCount, Label: 'Retries' }
        ]
    }
);

// ============================================================================
// Alert Annotations
// ============================================================================

annotate Services.Alert with @(
    UI: {
        HeaderInfo: {
            TypeName: 'Alert',
            TypeNamePlural: 'Alerts',
            Title: { Value: title }
        },
        LineItem: [
            { Value: severity, Label: 'Severity' },
            { Value: title, Label: 'Title' },
            { Value: alertType, Label: 'Type' },
            { Value: status, Label: 'Status' },
            { Value: triggeredAt, Label: 'Triggered At' }
        ]
    }
);
