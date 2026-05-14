using { conditional.app.schedules as sch } from '../../db/model/schedules';

extend service Services with {

  entity Schedule as projection on sch.Schedule actions {
    action runNow()    returns Schedule;
    action activate()  returns Schedule;
    action deactivate() returns Schedule;
  };

  @readonly
  entity ScheduleRun as projection on sch.ScheduleRun;

  entity ScheduledTaskchain as projection on sch.ScheduledTaskchain;

  entity CalendarEntry as projection on sch.CalendarEntry;

  // Returns the next N firing times for a cron expression (preview helper).
  function previewCron(cronExpression: String, timezone: String, count: Integer) returns array of Timestamp;
}
