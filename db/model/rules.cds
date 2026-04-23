namespace conditional.app.rules;

using { cuid } from '@sap/cds/common';

entity RuleTable : cuid {
  RuleNumber      : Integer @readonly;
  Rule            : LargeString;
  RuleDescription : String(1000);
  taskchains      : Association to many RuleTaskchainLink
                      on taskchains.rule = $self;
}

// Tabella ponte Rule → Taskchain (read-only, popolata dal sistema)
entity RuleTaskchainLink : cuid {
  rule      : Association to RuleTable;
  taskchain : String(100);  // nome della taskchain (es. "Task_Chain_xxx")
  spaceId   : String(100);  // space ID in DSP (es. "00_ADMINISTRATION")
}
