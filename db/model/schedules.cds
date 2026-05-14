namespace conditional.app.schedules;

using { cuid, managed } from '@sap/cds/common';

/**
 * Scheduled trigger for a DSP taskchain, IBP job or SAC job.
 * The scheduler engine lives in py-srv (APScheduler).
 */
entity Schedule : cuid, managed {
  name           : String(200) @title: 'Schedule Name';
  description    : String(1000) @title: 'Description';

  // What to run
  targetType     : String(10) @title: 'Target Type'; // DSP | IBP | SAC
  spaceId        : String(100) @title: 'DSP Space ID';      // for DSP
  taskchain      : String(200) @title: 'Taskchain';         // for DSP
  jobTemplate    : String(200) @title: 'Job Template';      // for IBP/SAC
  parameters     : LargeString @title: 'Parameters JSON';

  // When to run
  cronExpression : String(100) @title: 'Cron Expression';
  timezone       : String(50)  default 'Europe/Rome' @title: 'Timezone';

  // State
  isActive       : Boolean default true @title: 'Active';
  nextRunAt      : Timestamp @title: 'Next Run At';
  lastRunAt      : Timestamp @title: 'Last Run At';
  lastRunStatus  : String(20) @title: 'Last Run Status'; // success|error|running

  runs           : Association to many ScheduleRun on runs.schedule = $self;
}

/**
 * History of fired schedule executions.
 */
entity ScheduleRun : cuid {
  schedule      : Association to Schedule;
  triggeredAt   : Timestamp  @title: 'Triggered At';
  finishedAt    : Timestamp  @title: 'Finished At';
  status        : String(20) @title: 'Status'; // success|error|running
  targetType    : String(10) @title: 'Target Type';
  remoteId      : String(200) @title: 'Remote Execution ID';
  errorMessage  : String(2000) @title: 'Error Message';
}

/**
 * Task chains that have been added to the Scheduler list by users.
 * Persists the list across reloads instead of localStorage.
 * Key is (spaceId, name) so it can be linked back to the DSP catalog.
 */
entity ScheduledTaskchain : managed {
  key spaceId      : String(100);
  key name         : String(200);
  businessName     : String(500);
}

/**
 * Custom Calendar entries per task chain. Each row represents one
 * planned firing date+time. Parameters are an optional JSON string
 * passed to the task chain at trigger time.
 */
entity CalendarEntry : cuid, managed {
  spaceId     : String(100)  @title: 'DSP Space ID';
  taskchain   : String(200)  @title: 'Taskchain';
  runDate     : Date         @title: 'Date';
  runTime     : String(5)    @title: 'Time (HH:mm)';
  timezone    : String(50)   default 'Europe/Rome' @title: 'Timezone';
  active      : Boolean      default true @title: 'Active';
  parameters  : LargeString  @title: 'Parameters JSON';
}
