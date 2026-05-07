const cds = require('@sap/cds');

module.exports = cds.service.impl(async function () {
    const { RuleTable, RuleTaskchainLink, Taskchain } = this.entities;

    // Cache delle taskchain DSP per evitare query ripetute
    let taskchainCache = null;
    let taskchainCacheTime = 0;
    const CACHE_TTL_MS = 60000; // 1 minuto

    async function getTaskchainMap(authHeader = null) {
        const now = Date.now();
        if (taskchainCache && (now - taskchainCacheTime) < CACHE_TTL_MS) {
            return taskchainCache;
        }
        try {
            const taskchains = await fetchTaskchainsFromDSP(authHeader);
            // Mappa "spaceId|name" -> { spaceId, name, businessName }
            taskchainCache = new Map();
            for (const tc of taskchains) {
                const key = `${tc.spaceId}|${tc.name}`;
                taskchainCache.set(key, {
                    spaceId: tc.spaceId,
                    name: tc.name,
                    businessName: tc.businessName || tc.name
                });
            }
            taskchainCacheTime = now;
            return taskchainCache;
        } catch (error) {
            console.warn('⚠️ Could not fetch taskchain names for validation:', error.message);
            return new Map();
        }
    }

    // Handler custom per leggere Taskchain da Datasphere (entità virtuale)
    this.on('READ', Taskchain, async (req) => {
        try {
            // Extract Authorization header from incoming CDS request if present
            let authHeader = null;
            try {
                authHeader = (req && req.headers && (req.headers.authorization || req.headers.Authorization))
                    || (req && req._ && req._.req && req._.req.headers && (req._.req.headers.authorization || req._.req.headers.Authorization))
                    || null;
            } catch (e) {
                authHeader = null;
            }

            const taskchains = await fetchTaskchainsFromDSP(authHeader);
            return taskchains;
        } catch (error) {
            console.error('❌ Error fetching taskchains from DSP:', error.message);
            req.error(500, `Failed to fetch taskchains: ${error.message}`);
        }
    });

    // Dopo la lettura di RuleTaskchainLink, popola i campi virtuali existsInDsp, businessName, taskchainUrl
    this.after('READ', RuleTaskchainLink, async (data, req) => {
        if (!data || data.length === 0) return;

        // Assicurati che sia un array
        const links = Array.isArray(data) ? data : [data];
        
        // Extract Authorization header from incoming CDS request if present
        let authHeader = null;
        try {
            authHeader = (req && req.headers && (req.headers.authorization || req.headers.Authorization))
                || (req && req._ && req._.req && req._.req.headers && (req._.req.headers.authorization || req._.req.headers.Authorization))
                || null;
        } catch (e) {
            authHeader = null;
        }

        // Recupera la mappa delle taskchain esistenti in DSP
        const dspTaskchains = await getTaskchainMap(authHeader);

        for (const link of links) {
            if (link.taskchain && link.spaceId) {
                // Chiave composta spaceId|name
                const key = `${link.spaceId}|${link.taskchain}`;
                const tcInfo = dspTaskchains.get(key);
                const exists = !!tcInfo;
                
                link.existsInDsp = exists ? '✓ Found in DSP' : '⚠ Not in DSP';
                // Criticality: 3 = green (positive), 2 = yellow (critical/warning)
                link.existsInDspCriticality = exists ? 3 : 2;
                
                // Popola businessName se trovato
                link.businessName = tcInfo?.businessName || link.taskchain;
                
                // URL per navigare alla taskchain Object Page (chiave composta)
                link.taskchainUrl = exists ? `#/Taskchain(name='${link.taskchain}',spaceId='${link.spaceId}')` : '';
            } else if (link.taskchain) {
                // SpaceId mancante
                link.existsInDsp = '⚠ Missing spaceId';
                link.existsInDspCriticality = 2;
                link.businessName = link.taskchain;
                link.taskchainUrl = '';
            } else {
                link.existsInDsp = '';
                link.existsInDspCriticality = 0;
                link.businessName = '';
                link.taskchainUrl = '';
            }
        }
    });

    // Quando si crea un nuovo draft, assegna il prossimo RuleNumber
    this.before('NEW', RuleTable.drafts, async (req) => {
        // Trova il massimo RuleNumber tra le entità attive
        const maxActiveResult = await SELECT.one
            .from(RuleTable)
            .columns('max(RuleNumber) as maxNum');

        // Trova il massimo RuleNumber tra i draft esistenti
        const maxDraftResult = await SELECT.one
            .from(RuleTable.drafts)
            .columns('max(RuleNumber) as maxNum');

        const maxActive = maxActiveResult?.maxNum || 0;
        const maxDraft = maxDraftResult?.maxNum || 0;
        const nextNumber = Math.max(maxActive, maxDraft) + 1;

        req.data.RuleNumber = nextNumber;
    });

    // Quando si attiva il draft (SAVE), verifica e riassegna il RuleNumber se necessario
    // per evitare conflitti se nel frattempo altri draft sono stati salvati
    this.before('SAVE', RuleTable, async (req) => {
        // Solo per nuove entità (non per update di esistenti)
        if (req.event === 'CREATE' || !req.data.ID) {
            const maxResult = await SELECT.one
                .from(RuleTable)
                .columns('max(RuleNumber) as maxNum');

            const currentMax = maxResult?.maxNum || 0;

            // Se il RuleNumber del draft è già stato usato, assegna il prossimo disponibile
            if (req.data.RuleNumber <= currentMax) {
                req.data.RuleNumber = currentMax + 1;
            }
        }

        // Valida la sintassi del codice Python prima del save
        if (req.data.Rule) {
            await validateRuleSyntax(req.data.Rule, req);
        }
    });

    // Dopo il SAVE, estrai i possibili taskchain dal codice e aggiorna la tabella di link
    this.after('SAVE', RuleTable, async (data, req) => {
        if (data.Rule && data.ID) {
            await updateRuleTaskchains(data.ID, data.Rule);
        }
    });

    /**
    * Estrae i possibili valori di 'taskchain' e 'spaceId' dal codice Python e aggiorna RuleTaskchainLink
     */
    async function updateRuleTaskchains(ruleId, code) {
        if (!code || code.trim() === '') {
            // Nessun codice - rimuovi tutti i link esistenti
            await DELETE.from(RuleTaskchainLink).where({ rule_ID: ruleId });
            return;
        }

        try {
            // Estrai tutte le coppie (spaceId, taskchain) dal codice Python
            const taskchainPairs = extractTaskchainsFromCode(code);
            
            // Rimuovi i link esistenti per questa regola
            await DELETE.from(RuleTaskchainLink).where({ rule_ID: ruleId });
            
            // Inserisci i nuovi link
            if (taskchainPairs.length > 0) {
                const links = taskchainPairs.map(pair => ({
                    rule_ID: ruleId,
                    taskchain: pair.taskchain,
                    spaceId: pair.spaceId
                }));
                await INSERT.into(RuleTaskchainLink).entries(links);
                console.log(`✅ Updated taskchains for rule ${ruleId}:`, taskchainPairs);
            }
        } catch (error) {
            console.warn('⚠️ Could not extract taskchains from rule:', error.message);
            // Non blocchiamo il save per questo errore
        }
    }

    /**
    * Estrae le coppie (spaceId, taskchain) dal codice Python.
    * Cerca blocchi dove vengono assegnati spaceId e taskchain.
    * Se spaceId è definito una sola volta, lo usa per tutti i taskchain.
    * Restituisce array di { spaceId, taskchain }
     */
    function extractTaskchainsFromCode(code) {
        const results = [];
        
        // Pattern per spaceId = "..." o spaceId = '...'
        const spaceIdPattern = /spaceId\s*=\s*["']([^"']+)["']/g;
        // Pattern per taskchain = "..." o taskchain = '...'
        const taskchainPattern = /taskchain\s*=\s*["']([^"']+)["']/g;
        
        // Estrai tutti gli spaceId
        const spaceIds = [];
        let match;
        while ((match = spaceIdPattern.exec(code)) !== null) {
            spaceIds.push({ value: match[1].trim(), index: match.index });
        }

        // Estrai tutti i taskchain
        const taskchains = [];
        while ((match = taskchainPattern.exec(code)) !== null) {
            const value = match[1].trim();
            if (value && !value.includes('{')) {
                taskchains.push({ value, index: match.index });
            }
        }
        
        // Se c'è un solo spaceId nel codice, usalo come globale per tutti i taskchain
        const globalSpaceId = spaceIds.length === 1 ? spaceIds[0].value : '';

        // Associa ogni taskchain allo spaceId appropriato
        for (const tc of taskchains) {
            let assignedSpaceId = '';

            if (spaceIds.length === 1) {
                // Un solo spaceId: usalo per tutti i taskchain
                assignedSpaceId = globalSpaceId;
            } else if (spaceIds.length > 1) {
                // Più spaceId: trova quello più vicino che precede questo taskchain
                for (const sp of spaceIds) {
                    if (sp.index < tc.index) {
                        assignedSpaceId = sp.value;
                    }
                }
                // Se nessuno precede, prova a usare il primo definito
                if (!assignedSpaceId && spaceIds.length > 0) {
                    assignedSpaceId = spaceIds[0].value;
                }
            }

            // Crea la coppia (evita duplicati)
            const key = `${assignedSpaceId}|${tc.value}`;
            if (!results.find(r => `${r.spaceId}|${r.taskchain}` === key)) {
                results.push({
                    spaceId: assignedSpaceId,
                    taskchain: tc.value
                });
            }
        }
        
        return results;
    }

    /**
     * Valida la sintassi del codice Python chiamando il py-srv
     * Il py-srv verifica: sintassi, import consentiti, presenza di spaceId e result
     */
    async function validateRuleSyntax(code, req) {
        if (!code || code.trim() === '') {
            return; // Nessun codice da validare
        }

        try {
            // Determina l'URL del py-srv
            const pySrvUrl = getPySrvUrl();
            // Cerca l'header Authorization nella request CDS (diverse possibili collocazioni)
            let authHeader = null;
            try {
                authHeader = (req && req.headers && (req.headers.authorization || req.headers.Authorization))
                    || (req && req._ && req._.req && req._.req.headers && (req._.req.headers.authorization || req._.req.headers.Authorization))
                    || null;
            } catch (e) {
                authHeader = null;
            }

            const headers = { 'Content-Type': 'application/json' };
            if (authHeader) {
                headers['Authorization'] = authHeader;
            }

            const response = await fetch(`${pySrvUrl}/v1/rules/validate`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ code: code })
            });

            const result = await response.json();

            if (!result.valid) {
                // Validazione fallita - blocca il save
                let errorMsg = `Rule validation failed: ${result.error}`;
                if (result.line) {
                    errorMsg += ` (line ${result.line})`;
                }
                req.error(400, errorMsg);
            }
        } catch (error) {
            // Se il servizio non è disponibile, logga warning ma permetti il save
            console.warn('⚠️ Could not validate rule syntax:', error.message);
            // Opzionale: blocca il save anche se il servizio non è disponibile
            // req.error(503, 'Rule validation service unavailable');
        }
    }

    /**
     * Determina l'URL del py-srv in base all'ambiente
     */
    function getPySrvUrl() {
        // In produzione, usa la destination o l'URL diretto
        if (process.env.PY_SRV_URL) {
            return process.env.PY_SRV_URL;
        }
        
        // In sviluppo locale
        if (process.env.NODE_ENV !== 'production') {
            return 'http://localhost:8080';
        }
        
        // Default per CF - usa la destination configurata
        // L'URL viene iniettato dal binding nel mta.yaml
        return process.env.destinations?.find(d => d.name === 'py-srv-api')?.url 
            || 'http://localhost:8080';
    }

    /**
     * Esegue una query SQL sul py-srv via /v1/db/query (solo SELECT, cross-schema DSP HANA).
     */
    async function dbQuery(sql, params, authHeader) {
        const pySrvUrl = getPySrvUrl();
        const headers = { 'Content-Type': 'application/json' };
        if (authHeader) headers['Authorization'] = authHeader;

        const response = await fetch(`${pySrvUrl}/v1/db/query`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ sql, params: params || [] })
        });

        const result = await response.json();
        if (!result.success) {
            throw new Error(`db/query failed: ${result.error}`);
        }
        return result.data || [];
    }

    /**
     * Recupera le taskchain da Datasphere interrogando tutti gli space via HANA cross-schema.
     *
     * Step 1 (services.js:331-349): legge DWC_TENANT_OWNER.SPACE_SCHEMAS per ottenere
     *   tutti gli space con il relativo SCHEMA_NAME, filtrando gli schemi tecnici LIKE '%$TEC'.
     *
     * Step 2 (services.js:355-410): per ogni schema, legge "${schemaName}".DEPLOYED_METADATA
     *   dove REPOSITORY_OBJECT_TYPE = 'DWC_TASKCHAIN' per costruire l'entità virtuale Taskchain.
     */
    async function fetchTaskchainsFromDSP(authHeader = null) {
        // Step 1 — recupera space e schema name da DWC_TENANT_OWNER.SPACE_SCHEMAS
        const spaceRows = await dbQuery(
            `SELECT "SPACE_ID", "SCHEMA_NAME"
             FROM "DWC_TENANT_OWNER"."SPACE_SCHEMAS"
             WHERE "SCHEMA_NAME" NOT LIKE '%$TEC'`,
            [],
            authHeader
        );

        if (!spaceRows.length) {
            console.warn('⚠️ No spaces found in DWC_TENANT_OWNER.SPACE_SCHEMAS');
            return [];
        }

        // Step 2 — per ogni schema, legge le taskchain deployate da DEPLOYED_METADATA
        const taskchains = [];
        for (const { SPACE_ID: spaceId, SCHEMA_NAME: schemaName } of spaceRows) {
            if (!schemaName) continue;
            try {
                const rows = await dbQuery(
                    `SELECT
                        "OBJECT_NAME"        AS "name",
                        "DEPLOYED_BY"        AS "deployedBy",
                        "DEPLOYED_AT"        AS "deployedAt",
                        "BUSINESS_NAME"      AS "businessName",
                        "OBJECT_STATUS"      AS "objectStatus",
                        "MODIFICATION_DATE"  AS "modificationDate",
                        "OWNER"              AS "owner"
                     FROM "${schemaName}"."DEPLOYED_METADATA"
                     WHERE "REPOSITORY_OBJECT_TYPE" = 'DWC_TASKCHAIN'`,
                    [],
                    authHeader
                );
                for (const row of rows) {
                    taskchains.push({
                        name: row.name,
                        spaceId,
                        businessName: row.businessName || row.name,
                        owner: row.owner || row.deployedBy || '',
                        deployedBy: row.deployedBy || '',
                        deployedAt: row.deployedAt || null,
                        modificationDate: row.modificationDate || null,
                    });
                }
            } catch (e) {
                console.warn(`⚠️ Could not read DEPLOYED_METADATA for schema '${schemaName}' (space '${spaceId}'):`, e.message);
            }
        }

        console.log(`✅ Fetched ${taskchains.length} taskchains from DSP HANA (${spaceRows.length} spaces)`);
        return taskchains;
    }
});
