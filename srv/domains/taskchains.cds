using { conditional.app.taskchains as tc } from '../../db/model/taskchains';
using { conditional.app.taskchains as sk } from '../../db/model/skip_overrides';

extend service Services with {
  // Anagrafica Taskchain - letta dinamicamente da Datasphere
  @readonly
  entity Taskchain as projection on tc.Taskchain;

  // Space distinti disponibili in DSP
  @readonly
  entity TaskchainSpace as projection on tc.TaskchainSpace;

  // Step di una Taskchain - letti da DSP deployment metadata via handler
  @readonly
  entity TaskchainStep as projection on tc.TaskchainStep;

  // Overrides per skip step
  @odata.draft.enabled
  entity SkipOverride as projection on sk.SkipOverride;
}
