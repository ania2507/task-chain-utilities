using { cuid } from '@sap/cds/common';

namespace conditional.app.taskchains;

// Override table to control skip behavior for taskchain steps.
entity SkipOverride : cuid {
  spaceId         : String(100);
  taskchain        : String(200);
  stepId           : String(100);
  stepToBeChecked  : String(100);
  override             : Boolean default false;
  lastOverrideAt      : Timestamp;
}
