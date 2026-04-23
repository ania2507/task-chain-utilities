using { conditional.app.monitoring as mon } from '../../db/model/monitoring';

extend service Services with {
    // Monitoring Projects (no draft for simple CRUD)
    entity MonitoringProject as projection on mon.MonitoringProject;
    
    // Task Chains registered for monitoring
    entity MonitoringTaskChain as projection on mon.MonitoringTaskChain;
    
    // Task Executions (read-only, populated by ingestion API)
    @readonly
    entity TaskExecution as projection on mon.TaskExecution;
    
    // Alerts
    entity Alert as projection on mon.Alert;
    
    // Alert Rules Configuration
    @odata.draft.enabled
    entity AlertRule as projection on mon.AlertRule;
    
    // Project KPIs (calculated view)
    @readonly
    entity ProjectKPI as projection on mon.ProjectKPI;
    
    // Actions for monitoring operations
    action acknowledgeAlert(alertId: UUID) returns Alert;
    action resolveAlert(alertId: UUID, resolution: String) returns Alert;
    action triggerManualRun(chainId: UUID) returns TaskExecution;
}
