/**
 * Handlers for Schedule / ScheduleRun.
 *
 * The scheduling engine lives in py-srv (APScheduler).  Whenever a schedule
 * is created / updated / deleted we POST to /v1/scheduler/sync so py-srv
 * reloads the active jobs.  Actions (runNow / activate / deactivate /
 * previewCron) are also forwarded to py-srv.
 */
const cds = require('@sap/cds');

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
    const { Schedule, ScheduleRun } = srv.entities;

    // Resync after any persistence-affecting event
    async function notifySync(req) {
        const auth = getAuthHeader(req);
        const headers = auth ? { Authorization: auth } : {};
        try {
            const active = await SELECT.from(Schedule).where({ isActive: true });
            await callPy('/v1/scheduler/sync', 'POST', { schedules: active }, headers);
        } catch (e) {
            // Don't block CRUD if py-srv is unreachable; log only.
            console.warn('[scheduler] sync notification failed:', e.message);
        }
    }

    srv.after(['CREATE', 'UPDATE', 'DELETE'], Schedule, async (_data, req) => notifySync(req));

    // ----------------------------------------------------------------
    // Bound actions
    // ----------------------------------------------------------------
    srv.on('runNow', Schedule, async (req) => {
        const id = req.params[0]?.ID || req.params[0];
        const auth = getAuthHeader(req);
        const headers = auth ? { Authorization: auth } : {};
        const sched = await SELECT.one.from(Schedule).where({ ID: id });
        try {
            await callPy(`/v1/scheduler/run-now/${id}`, 'POST', { schedule: sched }, headers);
        } catch (e) {
            req.error(502, `Failed to trigger run: ${e.message}`);
            return;
        }
        return sched;
    });

    srv.on('activate', Schedule, async (req) => {
        const id = req.params[0]?.ID || req.params[0];
        await UPDATE(Schedule).set({ isActive: true }).where({ ID: id });
        await notifySync(req);
        return await SELECT.one.from(Schedule).where({ ID: id });
    });

    srv.on('deactivate', Schedule, async (req) => {
        const id = req.params[0]?.ID || req.params[0];
        await UPDATE(Schedule).set({ isActive: false }).where({ ID: id });
        await notifySync(req);
        return await SELECT.one.from(Schedule).where({ ID: id });
    });

    // ----------------------------------------------------------------
    // Unbound function: cron preview (next N firings)
    // ----------------------------------------------------------------
    srv.on('previewCron', async (req) => {
        const { cronExpression, timezone, count } = req.data;
        const auth = getAuthHeader(req);
        const headers = auth ? { Authorization: auth } : {};
        const qs = new URLSearchParams({
            cron: cronExpression || '',
            tz: timezone || 'Europe/Rome',
            count: String(count || 5)
        }).toString();
        try {
            const res = await callPy(`/v1/scheduler/preview?${qs}`, 'GET', null, headers);
            return res.next || [];
        } catch (e) {
            req.error(400, `Invalid cron expression: ${e.message}`);
        }
    });
};
