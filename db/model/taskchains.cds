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

// Space disponibili in DSP - Entità virtuale con valori distinti di spaceId
@cds.persistence.skip
entity TaskchainSpace {
  key spaceId : String(100);
}

// Step di una Taskchain - Entità virtuale letta da DSP deployment metadata
@cds.persistence.skip
entity TaskchainStep {
  key spaceId      : String(100);   // Space ID (parametro filtro In)
  key taskchain    : String(200);   // Nome tecnico taskchain (parametro filtro In)
  key objectId     : String(200);   // ID tecnico dello step
  businessName     : String(500);   // Label user-friendly dello step
  applicationId    : String(100);   // Tipo applicazione (es. TRANSFORMATION_FLOW)
  stepOrder        : Integer;       // Ordine nella chain
}
