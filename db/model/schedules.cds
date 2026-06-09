namespace conditional.app.schedules;

using { cuid, managed } from '@sap/cds/common';

/**
 * History of fired schedule executions.
 */
entity ScheduleRun : cuid {
  scheduleEntry : Association to ScheduleEntry;
  triggeredAt   : Timestamp  @title: 'Triggered At';
  finishedAt    : Timestamp  @title: 'Finished At';
  status        : String(20) @title: 'Status'; // success|error|running|skipped
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
 * One-shot scheduling entry for date+time based scheduling
 * (calendar upload, on-demand).
 */
entity ScheduleEntry : cuid, managed {
  spaceId     : String(100)  @title: 'DSP Space ID';
  taskchain   : String(200)  @title: 'Taskchain';
  runDate     : Date         @title: 'Date';
  runTime     : String(5)    @title: 'Time (HH:mm)';
  timezone    : String(50)   default 'Europe/Rome' @title: 'Timezone';
  active      : Boolean      default true @title: 'Active';
  parameters  : LargeString  @title: 'Parameters JSON';
  source      : String(20)   default 'calendar' @title: 'Source'; // 'calendar' | 'onDemand'
  runs        : Association to many ScheduleRun on runs.scheduleEntry = $self;
}

/**
 * Recurring schedule for Traffic Lights type monitoring.
 * Each record configures a recurring check for one task chain, ticking
 * every `checkInterval` minutes (set by the user and stored inside the
 * `parameters` JSON). At each tick the scheduler reads TrafficLightStatus
 * for the matching (spaceId, taskchain): if status = 'ready' the task
 * chain is launched in DSP.
 */
entity Schedule : cuid, managed {
  name           : String(200)  @title: 'Name';
  description    : String(500)  @title: 'Description';
  targetType     : String(10)   default 'DSP' @title: 'Target Type'; // DSP
  spaceId        : String(100)  @title: 'DSP Space ID';
  taskchain      : String(200)  @title: 'Taskchain';
  jobTemplate    : String(200)  @title: 'Job Template';
  parameters     : LargeString  @title: 'Parameters JSON';
  cronExpression : String(100)  @title: 'Cron Expression';
  timezone       : String(50)   default 'Europe/Rome' @title: 'Timezone';
  isActive       : Boolean      default true @title: 'Active';
  nextRunAt      : Timestamp    @title: 'Next Run At';
  lastRunStatus  : String(20)   @title: 'Last Run Status'; // triggered|skipped|error
}

/**
 * Semaphore table populated by external systems.
 * One row per (spaceId, taskchain) pair.
 * status values: 'ready' = ok to launch | 'running' = launched by scheduler |
 * 'on_hold' / 'disabled' = paused per the schedule's "After each run" policy |
 * 'completed' = run finished and "After each run" is disabled | other = blocked/wait
 * The Traffic Lights scheduler reads this table at each interval tick:
 * only rows with status = 'ready' trigger a DSP task chain launch.
 * After launch the scheduler sets status = 'running'. The scheduler watches
 * the run and, once it finishes, NEVER leaves it stuck on 'running':
 *   - if "After each run" is enabled, it sets 'on_hold' or 'disabled'
 *     (per the configured autoResetState);
 *   - otherwise it sets 'completed', and the external system is responsible
 *     for resetting it to 'ready' when a new run can be triggered.
 */
entity TrafficLightStatus {
  key spaceId   : String(100) @title: 'DSP Space ID';
  key taskchain : String(200) @title: 'Taskchain';
  status        : String(20)  @title: 'Status'; // 'ready' | 'running' | 'on_hold' | 'disabled' | 'completed'
  updatedAt     : Timestamp   @title: 'Last Updated';
  note          : String(500) @title: 'Note';
}
