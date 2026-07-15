/**
 * Handlers for CalendarEntry / Schedule / ScheduleRun.
 *
 * The scheduling engine lives in py-srv (APScheduler).  Whenever a
 * CalendarEntry or Schedule is created / updated / deleted we POST to
 * /v1/scheduler/sync so py-srv reloads the active jobs.
 */
const PY_SRV_URL = process.env.PY_SRV_URL || 'http://localhost:8080';

async function callPy(path, method = 'POST', body = null, headers = {}) {
    const url = `${PY_SRV_URL}${path}`;
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json', ...headers }
    };
    if (body) opts.body = JSON.stringify(body);
    try {
        const res = await fetch(url, opts);
        const text = await res.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        if (!res.ok) {
            throw new Error(`py-srv ${method} ${path} failed: ${res.status} ${text}`);
        }
        return data;
    } catch (err) {
        console.warn(`[scheduler] py-srv call failed (${method} ${path}):`, err.message);
        throw err;
    }
}

function getAuthHeader(req) {
    try {
        const h = (req && req.headers) || (req && req._ && req._.req && req._.req.headers) || {};
        return h.authorization || h.Authorization || null;
    } catch { return null; }
}

module.exports = function (srv) {
    const { ScheduleEntry, Schedule } = srv.entities;

    // Resync after any persistence-affecting event. py-srv holds the actual
    // APScheduler jobs in memory — if this notification is lost (e.g. py-srv
    // mid-restart during a deploy), the CRUD still succeeds but the entry
    // silently never gets (re-)scheduled. Retry a few times with a short
    // backoff before giving up, since these outages are typically seconds-long.
    const SYNC_RETRY_DELAYS_MS = [500, 1500];

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function notifySync(req) {
        const auth = getAuthHeader(req);
        const headers = auth ? { Authorization: auth } : {};
        for (let attempt = 0; ; attempt++) {
            try {
                await callPy('/v1/scheduler/sync', 'POST', {}, headers);
                return;
            } catch (e) {
                if (attempt >= SYNC_RETRY_DELAYS_MS.length) {
                    // Don't block CRUD if py-srv stays unreachable; log only.
                    console.warn('[scheduler] sync notification failed after retries:', e.message);
                    return;
                }
                console.warn(`[scheduler] sync notification failed (attempt ${attempt + 1}), retrying:`, e.message);
                await sleep(SYNC_RETRY_DELAYS_MS[attempt]);
            }
        }
    }

    // `srv.after` runs inside the still-open request transaction — the write
    // isn't committed yet at this point, so notifying py-srv here can make it
    // read the DB before the change is actually visible (py-srv uses its own,
    // separate connection). Defer to `req.on('succeeded', ...)`, which only
    // fires once the transaction has actually committed.
    function notifySyncAfterCommit(_data, req) {
        console.log('[scheduler] notifySyncAfterCommit: registering succeeded listener');
        req.on('succeeded', () => {
            console.log('[scheduler] succeeded event fired — calling notifySync now');
            notifySync(req);
        });
    }

    srv.after(['CREATE', 'UPDATE', 'DELETE'], ScheduleEntry, notifySyncAfterCommit);
    srv.after(['CREATE', 'UPDATE', 'DELETE'], Schedule, notifySyncAfterCommit);
};
