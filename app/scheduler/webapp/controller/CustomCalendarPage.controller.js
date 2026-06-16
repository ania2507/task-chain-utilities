sap.ui.define([
    "scheduler/controller/BaseController",
    "sap/ui/core/Fragment",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/Sorter",
    "sap/ui/core/routing/History"
], function (BaseController, Fragment, JSONModel, MessageBox, MessageToast, Filter, FilterOperator, Sorter, History) {
    "use strict";

    return BaseController.extend("scheduler.controller.CustomCalendarPage", {

        onInit: function () {
            var oModel = new JSONModel({
                name: "",
                spaceId: "",
                taskchain: "",
                calendarEntries: [],
                calendarFileStatus: "",
                entryDate: "",
                entryTime: "04:00",
                entryActive: true,
                entryParameters: "",
                parameters: "",
                activeCount: 0,
                totalCount: 0,
                nextRunLabel: "",
                lastRunAt: null,
                lastRunStatus: "",
                showPastEntries: false,
                filterDateFrom: null,
                filterDateTo: null,
                busy: false
            });
            this.getView().setModel(oModel, "edit");
            this._editModel = oModel;
            this.getRouter().getRoute("customCalendar").attachPatternMatched(this._onMatched, this);
        },

        _onMatched: function (oEvent) {
            var oArgs = oEvent.getParameter("arguments") || {};
            var oQuery = oArgs["?query"] || {};
            this._editModel.setData({
                name: oQuery.name || oQuery.taskchain || "",
                spaceId: oQuery.spaceId || "",
                taskchain: oQuery.taskchain || "",
                calendarEntries: [],
                calendarFileStatus: "",
                entryDate: "",
                entryTime: "04:00",
                entryActive: true,
                entryParameters: "",
                parameters: "",
                activeCount: 0,
                totalCount: 0,
                nextRunLabel: "",
                lastRunAt: null,
                lastRunStatus: "",
                showPastEntries: false,
                filterDateFrom: null,
                filterDateTo: null,
                busy: false
            });
            this._loadCalendarEntries();
            this._loadLastRun(oQuery.spaceId, oQuery.taskchain);
            this._consumeStepParametersResult();
        },

        // "Last Run" panel data comes directly from DSP's task execution
        // logs (v1/dsp/taskchain-runs), not from our own bookkeeping.
        _loadLastRun: function (spaceId, taskchain) {
            if (!spaceId || !taskchain) {
                this._editModel.setProperty("/lastRunAt", null);
                this._editModel.setProperty("/lastRunStatus", "");
                return;
            }
            var sUrl = "v1/dsp/taskchain-runs?spaceId=" + encodeURIComponent(spaceId)
                + "&taskchain=" + encodeURIComponent(taskchain) + "&limit=1";
            fetch(sUrl, { headers: { "Accept": "application/json" } })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    var run = (data && data.success && data.runs && data.runs[0]) || null;
                    this._editModel.setProperty("/lastRunAt", run ? (run.endTime || run.startTime) : null);
                    this._editModel.setProperty("/lastRunStatus", run ? run.status : "");
                }.bind(this))
                .catch(function () {
                    this._editModel.setProperty("/lastRunAt", null);
                    this._editModel.setProperty("/lastRunStatus", "");
                }.bind(this));
        },

        // Recompute the header summary (active/total entry counts and the
        // next upcoming active entry) whenever /calendarEntries changes.
        _updateSummary: function () {
            var aEntries = this._editModel.getProperty("/calendarEntries") || [];
            var aActive = aEntries.filter(function (e) { return e.active; });
            this._editModel.setProperty("/totalCount", aEntries.length);
            this._editModel.setProperty("/activeCount", aActive.length);

            var now = new Date();
            var oNext = null;
            aActive.forEach(function (e) {
                var sTime = e.rawTime || (e.time || "").replace(/\s*CET.*$/i, "");
                var dt = new Date(e.date + "T" + (sTime.length === 5 ? sTime + ":00" : sTime));
                if (isNaN(dt.getTime()) || dt < now) return;
                if (!oNext || dt < oNext.dt) oNext = { dt: dt, entry: e };
            });
            this._editModel.setProperty("/nextRunLabel", oNext ? (oNext.entry.dateLabel + "  " + oNext.entry.time) : "");
        },

        formatBusinessName: function (v) {
            if (!v) return "";
            return String(v).replace(/^\s*task\s*chain\s*[-:–]\s*/i, "");
        },

        formatDateTime: function (v) {
            if (!v) return "—";
            try {
                var d = new Date(v);
                if (isNaN(d.getTime())) return String(v);
                return d.toLocaleString("it-IT", {
                    day: "2-digit", month: "2-digit", year: "numeric",
                    hour: "2-digit", minute: "2-digit",
                    timeZone: "Europe/Rome"
                });
            } catch (e) {
                return String(v);
            }
        },

        formatCalendarEntriesTitle: function (sTaskchain) {
            try {
                return this.getResourceBundle().getText("calendar.entries", [sTaskchain || ""]);
            } catch (e) { return "Active entries for " + (sTaskchain || ""); }
        },

        onNavBack: function () {
            var oHistory = History.getInstance();
            var sPrev = oHistory.getPreviousHash();
            if (sPrev !== undefined) {
                window.history.go(-1);
            } else {
                this.getRouter().navTo("scheduleList", {}, true);
            }
        },

        // ------------------------------------------------------------
        // Template / upload
        // ------------------------------------------------------------
        onDownloadCalendarTemplate: function () {
            var sChain = this._editModel.getProperty("/taskchain") || "TASK_CHAIN_NAME";
            var aRows = [
                ["Chain", "Date", "Time"],
                [sChain, "2026-09-19", "04:00"],
                [sChain, "2026-09-26", "04:00"],
                [sChain, "2026-10-10", "04:00"]
            ];
            if (typeof window.XLSX === "undefined") {
                var sCsv = aRows.map(function (r) { return r.join(","); }).join("\n");
                this._downloadBlob(new Blob([sCsv], { type: "text/csv" }), "calendar_template.csv");
                return;
            }
            var XLSX = window.XLSX;
            var ws = XLSX.utils.aoa_to_sheet(aRows);
            var wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "Calendar");
            var out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
            this._downloadBlob(new Blob([out], { type: "application/octet-stream" }), "calendar_template.xlsx");
        },

        _downloadBlob: function (oBlob, sFilename) {
            var sUrl = window.URL.createObjectURL(oBlob);
            var a = document.createElement("a");
            a.href = sUrl; a.download = sFilename;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(sUrl);
        },

        onCalendarFileSelect: function (oEvt) {
            var oFile = oEvt.getParameter("files") && oEvt.getParameter("files")[0];
            if (!oFile) return;
            var that = this;
            var reader = new FileReader();
            reader.onload = function (e) {
                try {
                    var aRows = that._parseCalendarBuffer(e.target.result, oFile.name);
                    var sChain = that._editModel.getProperty("/taskchain");
                    var aEntries = that._buildCalendarEntries(aRows, sChain);
                    that._editModel.setProperty("/calendarFileStatus",
                        oFile.name + " — " + aEntries.length + " entries");
                    that._persistCalendarEntries(aEntries).then(function () {
                        that._loadCalendarEntries();
                    });
                } catch (err) {
                    console.error("[Scheduler] calendar parse error", err);
                    var oRb = that.getResourceBundle();
                    MessageBox.error(oRb.getText("calendar.parseError", [err.message || String(err)]));
                }
            };
            reader.onerror = function () { MessageBox.error("Could not read file"); };
            if (/\.csv$/i.test(oFile.name)) {
                reader.readAsText(oFile);
            } else {
                reader.readAsArrayBuffer(oFile);
            }
        },

        _parseCalendarBuffer: function (data) {
            if (typeof data === "string") {
                return data.split(/\r?\n/).filter(Boolean).map(function (line) {
                    return line.split(/[,;\t]/).map(function (s) { return s.trim(); });
                });
            }
            if (typeof window.XLSX === "undefined") {
                throw new Error("XLSX library not loaded. Use a .csv file instead.");
            }
            var XLSX = window.XLSX;
            var wb = XLSX.read(new Uint8Array(data), { type: "array", cellDates: true });
            var ws = wb.Sheets[wb.SheetNames[0]];
            return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: "yyyy-mm-dd" });
        },

        _buildCalendarEntries: function (aRows, sChain) {
            if (!aRows || !aRows.length) return [];
            var iStart = 0;
            var first = aRows[0].map(function (s) { return String(s || "").toLowerCase(); });
            if (first.indexOf("chain") !== -1 || first.indexOf("date") !== -1) iStart = 1;
            var aOut = [];
            var today = new Date(); today.setHours(0, 0, 0, 0);
            for (var i = iStart; i < aRows.length; i++) {
                var r = aRows[i] || [];
                var chain = String(r[0] || "").trim();
                if (!chain) continue;
                if (sChain && chain !== sChain) continue;
                var rawDate = r[1];
                var time = String(r[2] || "00:00").trim();
                var d = this._toIsoDate(rawDate);
                if (!d) continue;
                var dt = new Date(d + "T" + (time.length === 5 ? time + ":00" : time));
                aOut.push({
                    chain: chain,
                    date: d,
                    dateLabel: this._formatDateLabel(d),
                    time: time + " CET",
                    rawTime: time,
                    timezone: "Europe/Rome",
                    active: dt >= today,
                    parameters: ""
                });
            }
            return aOut;
        },

        _toIsoDate: function (v) {
            if (!v) return null;
            if (v instanceof Date && !isNaN(v)) {
                return v.getFullYear() + "-" +
                    ("0" + (v.getMonth() + 1)).slice(-2) + "-" +
                    ("0" + v.getDate()).slice(-2);
            }
            var s = String(v).trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
            var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
            if (m) {
                var yyyy = m[3].length === 2 ? ("20" + m[3]) : m[3];
                return yyyy + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
            }
            var d = new Date(s);
            if (!isNaN(d)) return this._toIsoDate(d);
            return null;
        },

        _formatDateLabel: function (sIso) {
            var d = new Date(sIso + "T00:00:00");
            if (isNaN(d)) return sIso;
            var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            return days[d.getDay()] + " " + ("0" + d.getDate()).slice(-2) + " " +
                months[d.getMonth()] + " " + d.getFullYear();
        },

        // ------------------------------------------------------------
        // CalendarEntry CRUD against HDI via OData
        // ------------------------------------------------------------
        _loadCalendarEntries: function () {
            var oModel = this.getModel();
            if (!oModel) { this._editModel.setProperty("/calendarEntries", []); return Promise.resolve(); }
            var sSpace = this._editModel.getProperty("/spaceId") || "";
            var sChain = this._editModel.getProperty("/taskchain") || "";
            var oList = oModel.bindList("/ScheduleEntry", undefined, [
                new Sorter("runDate"),
                new Sorter("runTime")
            ], [
                new Filter("spaceId", FilterOperator.EQ, sSpace),
                new Filter("taskchain", FilterOperator.EQ, sChain)
            ], {
                $select: "ID,spaceId,taskchain,runDate,runTime,timezone,active,parameters,source",
                $expand: "runs"
            });
            var that = this;
            this._editModel.setProperty("/busy", true);
            return oList.requestContexts(0, 1000).then(function (aCtx) {
                var now = new Date();
                var aEntries = aCtx.filter(function (c) {
                    var o = c.getObject();
                    return o.source !== "onDemand";
                }).map(function (c) {
                    var o = c.getObject();
                    var sTime = o.runTime || "00:00";
                    var dt = new Date(o.runDate + "T" + (sTime.length === 5 ? sTime + ":00" : sTime));
                    var aRuns = (o.runs || []).slice().sort(function (a, b) {
                        return new Date(b.triggeredAt) - new Date(a.triggeredAt);
                    });
                    var oLastRun = aRuns[0] || null;
                    return {
                        ID: o.ID,
                        chain: o.taskchain,
                        date: o.runDate,
                        dateLabel: that._formatDateLabel(o.runDate),
                        time: sTime + " CET",
                        rawTime: sTime,
                        timezone: o.timezone || "Europe/Rome",
                        active: !!o.active,
                        parameters: o.parameters || "",
                        isPast: !isNaN(dt.getTime()) && dt < now,
                        runStatus: oLastRun ? (oLastRun.status || "") : "",
                        runAt: oLastRun ? (oLastRun.finishedAt || oLastRun.triggeredAt) : null
                    };
                });
                that._editModel.setProperty("/calendarEntries", aEntries);
                if (aEntries.length && !that._editModel.getProperty("/calendarFileStatus")) {
                    that._editModel.setProperty("/calendarFileStatus",
                        aEntries.length + " entries loaded from server");
                }
                that._updateSummary();
                that._applyPastFilter();
                that._editModel.setProperty("/busy", false);
            }).catch(function (err) {
                that._editModel.setProperty("/busy", false);
                console.warn("Could not load calendar entries:", err && err.message);
            });
        },

        // Default: hide past entries (only future schedules). The "Show past
        // entries" switch reveals everything, so the user can review the
        // outcome of runs that already fired from this custom calendar.
        onTogglePastEntries: function () {
            this._applyPastFilter();
        },

        onDateFilterChange: function () {
            this._applyPastFilter();
        },

        _applyPastFilter: function () {
            var oTable = this.byId("calendarEntriesTable");
            if (!oTable) return;
            var oBinding = oTable.getBinding("items");
            if (!oBinding) return;

            var aFilters = [];
            var bShowPast = this._editModel.getProperty("/showPastEntries");
            if (!bShowPast) {
                aFilters.push(new Filter("isPast", FilterOperator.EQ, false));
            }

            var oFrom = this._editModel.getProperty("/filterDateFrom");
            if (oFrom) {
                aFilters.push(new Filter("date", FilterOperator.GE, this._toIsoDate(oFrom)));
            }
            var oTo = this._editModel.getProperty("/filterDateTo");
            if (oTo) {
                aFilters.push(new Filter("date", FilterOperator.LE, this._toIsoDate(oTo)));
            }

            oBinding.filter(aFilters);
        },

        _persistCalendarEntries: function (aEntries) {
            var oModel = this.getModel();
            if (!oModel || !aEntries || !aEntries.length) return Promise.resolve();
            var sSpace = this._editModel.getProperty("/spaceId") || "";
            var sChain = this._editModel.getProperty("/taskchain") || "";
            var oList = oModel.bindList("/ScheduleEntry");
            var aPromises = aEntries.map(function (e) {
                var oCtx = oList.create({
                    spaceId: sSpace,
                    taskchain: sChain,
                    runDate: e.date,
                    runTime: e.rawTime || (e.time || "").replace(/\s*CET.*$/i, ""),
                    timezone: e.timezone || "Europe/Rome",
                    active: !!e.active,
                    parameters: e.parameters || "",
                    source: "calendar"
                });
                return oCtx.created();
            });
            return Promise.all(aPromises).catch(function (err) {
                console.warn("Could not persist calendar entries:", err && err.message);
            });
        },

        // ------------------------------------------------------------
        // Add / Edit / Remove single entry
        // ------------------------------------------------------------
        onAddCalendarEntry: function () {
            this._editingEntryId = null;
            var now = new Date();
            this._editModel.setProperty("/entryDate", now.toISOString().slice(0, 10));
            this._editModel.setProperty("/entryTime", "04:00");
            this._editModel.setProperty("/entryActive", true);
            this._editModel.setProperty("/entryParameters", "");
            this._openCalendarEntryDialog();
        },

        onEditCalendarEntry: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            var o = oCtx.getObject();
            this._editingEntryId = o.ID;
            this._editModel.setProperty("/entryDate", o.date);
            this._editModel.setProperty("/entryTime", o.rawTime || (o.time || "").replace(/\s*CET.*$/i, ""));
            this._editModel.setProperty("/entryActive", !!o.active);
            this._editModel.setProperty("/entryParameters", o.parameters || "");
            this._openCalendarEntryDialog();
        },

        _openCalendarEntryDialog: function () {
            var oView = this.getView();
            if (!this._pCalendarEntryDialog) {
                this._pCalendarEntryDialog = Fragment.load({
                    id: oView.getId(),
                    name: "scheduler.view.fragments.CalendarEntryDialog",
                    controller: this
                }).then(function (oDialog) {
                    oView.addDependent(oDialog);
                    oDialog.setModel(this._editModel, "edit");
                    return oDialog;
                }.bind(this)).catch(function (e) {
                    console.error("[Scheduler] CalendarEntryDialog load failed", e);
                    MessageToast.show("CalendarEntryDialog load failed: " + (e && e.message || e));
                    this._pCalendarEntryDialog = null;
                }.bind(this));
            }
            this._pCalendarEntryDialog.then(function (oDialog) {
                if (oDialog) { oDialog.open(); }
            });
        },

        onCloseCalendarEntryDialog: function () {
            if (this._pCalendarEntryDialog) {
                this._pCalendarEntryDialog.then(function (d) { d.close(); });
            }
        },

        onSaveCalendarEntry: function () {
            var d = this._editModel.getData();
            if (!d.entryDate || !d.entryTime) {
                this.error("Date and time are required");
                return;
            }
            if (d.entryParameters && String(d.entryParameters).trim()) {
                try { JSON.parse(d.entryParameters); }
                catch (e) { this.error("Parameters must be valid JSON: " + e.message); return; }
            }
            var oModel = this.getModel();
            var that = this;
            if (this._editingEntryId) {
                var oList = oModel.bindList("/ScheduleEntry", undefined, undefined, [
                    new Filter("ID", FilterOperator.EQ, this._editingEntryId)
                ]);
                oList.requestContexts(0, 1).then(function (aCtx) {
                    if (!aCtx.length) return;
                    var oCtx = aCtx[0];
                    oCtx.setProperty("runDate", d.entryDate);
                    oCtx.setProperty("runTime", d.entryTime);
                    oCtx.setProperty("active", !!d.entryActive);
                    oCtx.setProperty("parameters", d.entryParameters || "");
                    return oModel.submitBatch(oModel.getUpdateGroupId());
                }).then(function () {
                    that.onCloseCalendarEntryDialog();
                    that._loadCalendarEntries();
                }).catch(function (err) {
                    that.error(err.message || String(err));
                });
            } else {
                var oList2 = oModel.bindList("/ScheduleEntry");
                var oCtx2 = oList2.create({
                    spaceId: d.spaceId || "",
                    taskchain: d.taskchain || "",
                    runDate: d.entryDate,
                    runTime: d.entryTime,
                    timezone: "Europe/Rome",
                    active: !!d.entryActive,
                    parameters: d.entryParameters || ""
                });
                oCtx2.created().then(function () {
                    that.onCloseCalendarEntryDialog();
                    that._loadCalendarEntries();
                }).catch(function (err) {
                    that.error(err.message || String(err));
                });
            }
        },

        onDeleteAllEntries: function () {
            var aEntries = this._editModel.getProperty("/calendarEntries") || [];
            if (!aEntries.length) return;
            var that = this;
            var oRb = this.getResourceBundle();
            MessageBox.confirm(oRb.getText("calendar.confirmDeleteAll", [aEntries.length]), {
                onClose: function (sAction) {
                    if (sAction !== MessageBox.Action.OK) return;
                    var oModel = that.getModel();
                    var aIds = aEntries.map(function (e) { return e.ID; }).filter(Boolean);
                    var aPromises = aIds.map(function (sId) {
                        var oList = oModel.bindList("/ScheduleEntry", undefined, undefined, [
                            new Filter("ID", FilterOperator.EQ, sId)
                        ]);
                        return oList.requestContexts(0, 1).then(function (aCtx) {
                            if (aCtx.length) return aCtx[0].delete();
                        });
                    });
                    that._editModel.setProperty("/busy", true);
                    Promise.all(aPromises).then(function () {
                        that._editModel.setProperty("/busy", false);
                        that._editModel.setProperty("/calendarEntries", []);
                        that._editModel.setProperty("/calendarFileStatus", "");
                        that._updateSummary();
                    }).catch(function (err) {
                        that._editModel.setProperty("/busy", false);
                        that.error(err.message || String(err));
                    });
                }
            });
        },

        onRemoveCalendarEntry: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            var o = oCtx.getObject();
            var that = this;
            var oRb = this.getResourceBundle();
            MessageBox.confirm(oRb.getText("calendar.confirmRemove", [o.dateLabel, o.time]), {
                onClose: function (sAction) {
                    if (sAction !== MessageBox.Action.OK) return;
                    var oModel = that.getModel();
                    var oList = oModel.bindList("/ScheduleEntry", undefined, undefined, [
                        new Filter("ID", FilterOperator.EQ, o.ID)
                    ]);
                    oList.requestContexts(0, 1).then(function (aCtx) {
                        if (!aCtx.length) return;
                        return aCtx[0].delete();
                    }).then(function () {
                        that._loadCalendarEntries();
                    }).catch(function (err) {
                        that.error(err.message || String(err));
                    });
                }
            });
        },

        // ------------------------------------------------------------
        // Step parameters dialog (per-row)
        // ------------------------------------------------------------
        onCalendarConfigureRowParams: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            this._calendarRowCtx = oCtx;
            this._editModel.setProperty("/parameters", oCtx.getProperty("parameters") || "");
            this.onConfigureStepParameters();
        },

        onConfigureStepParameters: function () {
            var d = this._editModel.getData();
            this.getRouter().navTo("stepParameters", {
                "?query": {
                    spaceId: d.spaceId || "",
                    taskchain: d.taskchain || "",
                    name: d.name || d.taskchain || "",
                    returnTo: "customCalendar"
                }
            });
        },

        _consumeStepParametersResult: function () {
            var oComp = this.getOwnerComponent();
            var s = oComp && oComp._stepParamsState;
            if (!s || s.taskchain !== this._editModel.getProperty("/taskchain") || !s.parametersJson) return;
            // Single-shot consume
            oComp._stepParamsState = null;
            if (this._calendarRowCtx) {
                var oRow = this._calendarRowCtx.getObject();
                try { this._editModel.setProperty(this._calendarRowCtx.getPath() + "/parameters", s.parametersJson); } catch (e) { /* ignore */ }
                if (oRow && oRow.ID) {
                    var oModel = this.getModel();
                    var oList = oModel.bindList("/ScheduleEntry", undefined, undefined, [
                        new Filter("ID", FilterOperator.EQ, oRow.ID)
                    ]);
                    oList.requestContexts(0, 1).then(function (aCtx) {
                        if (!aCtx.length) return;
                        aCtx[0].setProperty("parameters", s.parametersJson);
                        return oModel.submitBatch(oModel.getUpdateGroupId());
                    }).catch(function (err) {
                        console.warn("Could not persist step parameters:", err && err.message);
                    });
                }
                this._calendarRowCtx = null;
            } else {
                this._editModel.setProperty("/parameters", s.parametersJson);
            }
        },

        onCloseStepParameters: function () {
            if (this._pStepDialog) this._pStepDialog.then(function (d) { d.close(); });
        },

        onSaveStepParameters: function () {
            var s = this._editModel.getProperty("/parameters");
            if (s && String(s).trim()) {
                try { JSON.parse(s); }
                catch (e) {
                    this.error("Parameters must be valid JSON: " + e.message);
                    return;
                }
            }
            var that = this;
            if (this._calendarRowCtx) {
                var oRow = this._calendarRowCtx.getObject();
                this._editModel.setProperty(this._calendarRowCtx.getPath() + "/parameters", s || "");
                if (oRow && oRow.ID) {
                    var oModel = this.getModel();
                    var oList = oModel.bindList("/ScheduleEntry", undefined, undefined, [
                        new Filter("ID", FilterOperator.EQ, oRow.ID)
                    ]);
                    oList.requestContexts(0, 1).then(function (aCtx) {
                        if (!aCtx.length) return;
                        aCtx[0].setProperty("parameters", s || "");
                        return oModel.submitBatch(oModel.getUpdateGroupId());
                    }).catch(function (err) {
                        console.warn("Could not persist step parameters:", err && err.message);
                    });
                }
                this._calendarRowCtx = null;
            }
            this.onCloseStepParameters();
        },

        // ------------------------------------------------------------
        // Confirm: schedule all active entries via py-srv
        // ------------------------------------------------------------
        onConfirmCustomCalendar: function () {
            var d = this._editModel.getData();
            var aEntries = (d.calendarEntries || []).filter(function (e) { return e.active; });
            if (!aEntries.length) {
                this.error("No active entries to schedule");
                return;
            }
            this._editModel.setProperty("/busy", true);
            var that = this;
            var aPromises = aEntries.map(function (e) {
                var params = null;
                if (e.parameters && String(e.parameters).trim()) {
                    try { params = JSON.parse(e.parameters); } catch (_) { params = null; }
                }
                var payload = {
                    spaceId: d.spaceId,
                    taskchain: d.taskchain,
                    runAt: e.date + "T" + (e.rawTime || (e.time || "").replace(/\s*CET.*$/i, "")) + ":00",
                    parameters: params
                };
                return that.callScheduler("/schedule-once", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
            });
            Promise.all(aPromises).then(function () {
                that._editModel.setProperty("/busy", false);
                that.toast(aEntries.length + " calendar entries scheduled for " + (d.name || d.taskchain));
                that.onNavBack();
            }).catch(function (err) {
                that._editModel.setProperty("/busy", false);
                that.error(err.message || String(err));
            });
        }
    });
});
