namespace conditional.app.taskchains;

// Anagrafica Taskchain - Entità virtuale letta da Datasphere (non persistita)
@cds.persistence.skip
entity Taskchain {
  key name         : String(200);   // Nome tecnico della taskchain
  key spaceId      : String(100);   // Space ID in DSP (parte della chiave)
  businessName     : String(500);   // Label user-friendly
  owner            : String(100);   // Creatore/proprietario
  deployedBy       : String(100);   // Chi ha deployato
  deployedAt       : Timestamp;     // Quando è stata deployata
  modificationDate : Timestamp;     // Ultima modifica
}
