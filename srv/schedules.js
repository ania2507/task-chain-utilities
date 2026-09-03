/**
 * Handlers for CalendarEntry / Schedule / ScheduleRun.
 *
 * The scheduling engine lives in py-srv. Whenever a
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
    // jobs in memory — if this notification is lost (e.g. py-srv
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

    // --- SAP Job Scheduling service bookkeeping ------------------------
    //
    // When py-srv delegates a row's firing to SAP Job Scheduling service
    // (see scheduler_service.py), it stamps jobSchedulerScheduleId on that
    // row and, from then on, leaves an already-linked row alone on sync() —
    // recreating the external schedule on every sync would burn API calls
    // and rate limits for no reason. That means an edit made here has to
    // proactively force recreation, and a hard delete has to proactively
    // tell py-srv to remove the now-orphaned external schedule, since once
    // the row is gone py-srv's own reconciliation has no row left to read
    // jobSchedulerScheduleId from.

    // Capture the row's current jobSchedulerScheduleId before it's overwritten
    // (UPDATE) or removed (DELETE) — afterwards there's no row left to read
    // the *old* id from. The row's other columns are never at risk here: CAP's
    // UPDATE is a partial merge (untouched columns keep their stored value),
    // and py-srv always rebuilds the schedule from the current full row at
    // sync() time — only the stale external scheduleId itself needs rescuing.
    async function captureJobSchedulerId(Entity, req) {
        try {
            const row = await SELECT.one.from(Entity)
                .columns('jobSchedulerScheduleId')
                .where({ ID: req.data.ID });
            req._jobSchedulerScheduleId = row && row.jobSchedulerScheduleId;
        } catch (e) {
            console.warn('[scheduler] failed to read jobSchedulerScheduleId before write:', e.message);
        }
    }

    // Any update clears the link (after stashing the old id above) so the
    // next sync() recreates the external schedule with fresh data, regardless
    // of which field was actually edited.
    async function captureThenClearJobSchedulerId(Entity, req) {
        await captureJobSchedulerId(Entity, req);
        req.data.jobSchedulerScheduleId = null;
    }
    srv.before('UPDATE', ScheduleEntry, (req) => captureThenClearJobSchedulerId(ScheduleEntry, req));
    srv.before('UPDATE', Schedule, (req) => captureThenClearJobSchedulerId(Schedule, req));

    srv.before('DELETE', ScheduleEntry, (req) => captureJobSchedulerId(ScheduleEntry, req));
    srv.before('DELETE', Schedule, (req) => captureJobSchedulerId(Schedule, req));

    async function notifyExternalDelete(kind, scheduleId, req) {
        if (!scheduleId) return;
        const auth = getAuthHeader(req);
        const headers = auth ? { Authorization: auth } : {};
        try {
            await callPy('/v1/scheduler/jobscheduler-delete', 'POST', { kind, scheduleId }, headers);
        } catch (e) {
            console.warn(`[scheduler] jobscheduler-delete notification failed (kind=${kind}):`, e.message);
        }
    }
    srv.after('DELETE', ScheduleEntry, (_data, req) => {
        // Braces, no return: unlike notifySync above, notifyExternalDelete's
        // own promise must NOT be returned here. CAP's context.emit() awaits
        // every 'succeeded' listener's return value before responding to the
        // client (see @sap/cds lib/req/context.js) - an implicit-return arrow
        // (`() => fn()`) hands that promise back and makes the client wait on
        // this network round-trip; a braced body returns undefined instead,
        // keeping this truly fire-and-forget.
        req.on('succeeded', () => { notifyExternalDelete('entry', req._jobSchedulerScheduleId, req); });
    });
    srv.after('DELETE', Schedule, (_data, req) => {
        req.on('succeeded', () => { notifyExternalDelete('traffic_light', req._jobSchedulerScheduleId, req); });
    });

    // Same cleanup on UPDATE: without this, the old external schedule (from
    // before the edit) would never be deleted — just silently orphaned, since
    // its id was already cleared from the row before py-srv ever saw it.
    srv.after('UPDATE', ScheduleEntry, (_data, req) => {
        // Braces, no return: unlike notifySync above, notifyExternalDelete's
        // own promise must NOT be returned here. CAP's context.emit() awaits
        // every 'succeeded' listener's return value before responding to the
        // client (see @sap/cds lib/req/context.js) - an implicit-return arrow
        // (`() => fn()`) hands that promise back and makes the client wait on
        // this network round-trip; a braced body returns undefined instead,
        // keeping this truly fire-and-forget.
        req.on('succeeded', () => { notifyExternalDelete('entry', req._jobSchedulerScheduleId, req); });
    });
    srv.after('UPDATE', Schedule, (_data, req) => {
        req.on('succeeded', () => { notifyExternalDelete('traffic_light', req._jobSchedulerScheduleId, req); });
    });
};
