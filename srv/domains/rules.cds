using { conditional.app.rules as rules } from '../../db/model/rules';

extend service Services with {
  @odata.draft.enabled
  entity RuleTable as projection on rules.RuleTable;

  @readonly
  entity RuleTaskchainLink as projection on rules.RuleTaskchainLink {
    *,
    // Campi virtuali calcolati dal service handler (non persistiti)
    @Core.Computed null as existsInDsp : String(20) @title : 'Status',
    @Core.Computed null as existsInDspCriticality : Integer @title : 'Criticality',
    @Core.Computed null as businessName : String(500) @title : 'Business Name',
    @Core.Computed null as taskchainUrl : String(500) @title : 'URL'
  };
}
