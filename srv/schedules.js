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

    // Resync after any persistence-affecting event
    async function notifySync(req) {
        const auth = getAuthHeader(req);
        const headers = auth ? { Authorization: auth } : {};
        try {
            await callPy('/v1/scheduler/sync', 'POST', {}, headers);
        } catch (e) {
            // Don't block CRUD if py-srv is unreachable; log only.
            console.warn('[scheduler] sync notification failed:', e.message);
        }
    }

    srv.after(['CREATE', 'UPDATE', 'DELETE'], ScheduleEntry, async (_data, req) => notifySync(req));
    srv.after(['CREATE', 'UPDATE', 'DELETE'], Schedule, async (_data, req) => notifySync(req));
};
