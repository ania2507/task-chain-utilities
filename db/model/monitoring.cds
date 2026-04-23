namespace conditional.app.monitoring;

using { cuid, managed } from '@sap/cds/common';

/**
 * Monitoring Project - Container for monitoring configuration
 */
entity MonitoringProject : cuid, managed {
    name            : String(200) @title: 'Project Name';
    description     : String(1000) @title: 'Description';
    status          : String(20) default 'Active' @title: 'Status';
    slaTarget       : Decimal(5,2) @title: 'SLA Target (%)';
    alertThreshold  : Integer @title: 'Alert Threshold';
    taskChains      : Association to many MonitoringTaskChain on taskChains.project = $self;
    alerts          : Association to many Alert on alerts.project = $self;
}

/**
 * Task Chain registered for monitoring
 */
entity MonitoringTaskChain : cuid, managed {
    project         : Association to MonitoringProject;
    chainName       : String(200) @title: 'Task Chain Name';
    spaceId         : String(100) @title: 'DSP Space ID';
    description     : String(500) @title: 'Description';
    version         : String(20) @title: 'Version';
    status          : String(20) default 'Active' @title: 'Status';
    slaTarget       : Decimal(5,2) @title: 'SLA Target (%)';
    executions      : Association to many TaskExecution on executions.taskChain = $self;
}

/**
 * Individual Task Execution Record
 */
entity TaskExecution : cuid {
    taskChain       : Association to MonitoringTaskChain;
    runId           : String(50) @title: 'Run ID';
    taskName        : String(200) @title: 'Task Name';
    status          : String(20) @title: 'Status'; // success, error, running, pending
    startTimestamp  : Timestamp @title: 'Start Time';
    endTimestamp    : Timestamp @title: 'End Time';
    duration        : Integer @title: 'Duration (seconds)';
    retryCount      : Integer default 0 @title: 'Retry Count';
    errorCode       : String(50) @title: 'Error Code';
    errorMessage    : String(2000) @title: 'Error Message';
    correlationId   : String(100) @title: 'Correlation ID';
    metrics         : LargeString @title: 'Metrics JSON';
}

/**
 * Alert Configuration and History
 */
entity Alert : cuid, managed {
    project         : Association to MonitoringProject;
    taskChain       : Association to MonitoringTaskChain;
    alertType       : String(50) @title: 'Alert Type'; // threshold, sla, anomaly
    severity        : String(10) @title: 'Severity'; // P1, P2, P3
    title           : String(200) @title: 'Alert Title';
    message         : String(2000) @title: 'Alert Message';
    status          : String(20) default 'Open' @title: 'Status'; // Open, Acknowledged, Resolved
    triggeredAt     : Timestamp @title: 'Triggered At';
    acknowledgedAt  : Timestamp @title: 'Acknowledged At';
    resolvedAt      : Timestamp @title: 'Resolved At';
    acknowledgedBy  : String(100) @title: 'Acknowledged By';
}

/**
 * Alert Rule Configuration
 */
entity AlertRule : cuid, managed {
    project         : Association to MonitoringProject;
    taskChain       : Association to MonitoringTaskChain;
    ruleName        : String(200) @title: 'Rule Name';
    ruleType        : String(50) @title: 'Rule Type'; // threshold, sla, anomaly
    condition       : String(500) @title: 'Condition Expression';
    threshold       : Decimal(10,2) @title: 'Threshold Value';
    severity        : String(10) @title: 'Severity';
    notifyChannels  : String(500) @title: 'Notification Channels'; // email,slack,webhook
    isActive        : Boolean default true @title: 'Is Active';
}

/**
 * Aggregated KPIs per Project (virtual/calculated)
 */
@cds.persistence.skip
entity ProjectKPI {
    key projectId       : UUID;
    successRate         : Decimal(5,2);
    errorsLast24h       : Integer;
    avgDurationP95      : Decimal(10,2);
    activeAlerts        : Integer;
    slaCompliance       : Decimal(5,2);
    totalExecutions     : Integer;
}
