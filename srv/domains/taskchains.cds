using { conditional.app.taskchains as tc } from '../../db/model/taskchains';
using { conditional.app.taskchains as sk } from '../../db/model/skip_overrides';

extend service Services with {
  // Anagrafica Taskchain - letta dinamicamente da Datasphere
  @readonly
  entity Taskchain as projection on tc.Taskchain;

  // Overrides per skip step
  @odata.draft.enabled
  entity SkipOverride as projection on sk.SkipOverride;
}
