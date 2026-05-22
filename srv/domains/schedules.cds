using { conditional.app.schedules as sch } from '../../db/model/schedules';

extend service Services with {

  @readonly
  entity ScheduleRun as projection on sch.ScheduleRun;

  entity ScheduledTaskchain as projection on sch.ScheduledTaskchain;

  entity ScheduleEntry as projection on sch.ScheduleEntry;

  entity Schedule as projection on sch.Schedule;

  entity TrafficLightStatus as projection on sch.TrafficLightStatus;
}
