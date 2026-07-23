sap.ui.define([
    "scheduler/controller/BaseController",
    "sap/ui/core/Fragment",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/Sorter"
], function (BaseController, Fragment, MessageBox, MessageToast, JSONModel, Filter, FilterOperator, Sorter) {
    "use strict";

    var EMPTY = {
        ID: null,
        name: "",
        description: "",
        targetType: "DSP",
        spaceId: "",
        taskchain: "",
        jobTemplate: "",
        parameters: "",
        cronExpression: "0 6 * * *",
        timezone: "Europe/Rome",
        isActive: true,
        chainLocked: false
    };

    // Storage key for persisting "added rows" across reloads (user-specific not needed for local dev)
    var STORAGE_KEY = "scheduler.addedTaskchains.v1";

    return BaseController.extend("scheduler.controller.ScheduleList", {

        onInit: function () {
            this._editModel = new JSONModel(Object.assign({}, EMPTY));
            this._previewModel = new JSONModel({ next: [], busy: false });

            // Page model: rows = task chains the user has added to the list
            this._pageModel = new JSONModel({
                rows: [],
                busy: false,
                searchQuery: "",
                filterStatus: "all",
                filterType: "all",
                filterSpace: "all",
                spaceOptions: [],
                summary: { total: 0, scheduled: 0, notScheduled: 0, paused: 0 },
                filteredCount: 0
            });
            this.getView().setModel(this._pageModel, "page");

            this.getRouter().getRoute("scheduleList").attachPatternMatched(this._onListMatched, this);
        },

        _onListMatched: function () {
            this._pageModel.setProperty("/busy", true);
            this._loadAdded().then(function () {
                return this._refreshSchedulesForRows();
            }.bind(this)).finally(function () {
                this._pageModel.setProperty("/busy", false);
            }.bind(this));
        },

        // ------------------------------------------------------------
        // Persistence of the "added" task chains (HDI via OData)
        // ------------------------------------------------------------
        _loadAdded: function () {
            var oModel = this.getModel();
            if (!oModel) return Promise.resolve();
            var oList = oModel.bindList("/ScheduledTaskchain", undefined, undefined, undefined, {
                $select: "spaceId,name,businessName"
            });
            return oList.requestContexts(0, 1000).then(function (aCtx) {
                var rows = aCtx.map(function (c) {
                    var o = c.getObject();
                    return { spaceId: o.spaceId, name: o.name, businessName: o.businessName || o.name, hasSchedule: false, schedulesLoaded: false, filterStatus: "notScheduled", filterType: "none" };
                });
                this._pageModel.setProperty("/rows", rows);
                this._updateSummary();
            }.bind(this)).catch(function (err) {
                console.warn("Could not load saved task chains:", err && err.message);
            });
        },

        _rowKey: function (sSpaceId, sName) {
            return (sSpaceId || "") + "|" + (sName || "");
        },

        // ------------------------------------------------------------
        // For each row, look up the corresponding Schedule (if any).
        // Two sources are merged:
        //  - App schedules (entity /Schedule)     → enables Edit / Run buttons
        //  - DSP-native schedules (REST endpoint) → info-only (read-only)
        // ------------------------------------------------------------
        _refreshSchedulesForRows: function () {
            var rows = this._pageModel.getProperty("/rows") || [];
            if (!rows.length) return Promise.resolve();
            var oModel = this.getModel();
            if (!oModel) return Promise.resolve();
            // Mark all rows as "not yet loaded" so the Schedule button stays hidden during fetch
            rows.forEach(function (r) { r.schedulesLoaded = false; });
            this._pageModel.setProperty("/rows", rows.slice());

            var oList = oModel.bindList("/Schedule", undefined, undefined, undefined, {
                $select: "ID,name,spaceId,taskchain,targetType,isActive,cronExpression,timezone,nextRunAt,lastRunStatus"
            });
            var pApp = oList.requestContexts(0, 500).then(function (aCtx) {
                var map = {};
                aCtx.forEach(function (c) {
                    var o = c.getObject();
                    if (o.targetType !== "DSP" || !o.taskchain) return;
                    var k = this._rowKey(o.spaceId, o.taskchain);
                    if (!map[k] || (o.isActive && !map[k].isActive)) map[k] = o;
                }.bind(this));
                return map;
            }.bind(this)).catch(function () { return {}; });

            // Custom Calendar entries (HDI) - keep FULL list per row so the
            // popover can show every persisted date.
            var oCalList = oModel.bindList("/ScheduleEntry", undefined, undefined, undefined, {
                $select: "ID,spaceId,taskchain,runDate,runTime,timezone,active,source"
            });
            var pCal = oCalList.requestContexts(0, 1000).then(function (aCtx) {
                var map = {};
                var now = new Date();
                aCtx.forEach(function (c) {
                    var o = c.getObject();
                    if (!o.taskchain || o.active === false) return;
                    var iso = (o.runDate || "") + "T" + (o.runTime || "00:00") + ":00";
                    var dt = new Date(iso);
                    if (isNaN(dt.getTime()) || dt < now) return;
                    var k = this._rowKey(o.spaceId, o.taskchain);
                    (map[k] = map[k] || []).push({
                        ID: o.ID,
                        spaceId: o.spaceId,
                        taskchain: o.taskchain,
                        runDate: o.runDate,
                        runTime: o.runTime,
                        nextRunAt: dt.toISOString(),
                        timezone: o.timezone,
                        source: o.source || "calendar",
                        _dt: dt
                    });
                }.bind(this));
                // Sort each list earliest-first
                Object.keys(map).forEach(function (k) { map[k].sort(function (a, b) { return a._dt - b._dt; }); });
                return map;
            }.bind(this)).catch(function () { return {}; });

            var pDsp = this.callScheduler.bind(this) ?
                this._fetchDspSchedules().catch(function () { return {}; }) :
                Promise.resolve({});

            return Promise.all([pApp, pDsp, pCal]).then(function (results) {
                var appMap = results[0] || {};
                var dspMap = results[1] || {};
                var calMap = results[2] || {};

                rows.forEach(function (r) {
                    var k = this._rowKey(r.spaceId, r.name);
                    var s = appMap[k];
                    var d = dspMap[k];
                    var cList = calMap[k] || [];

                    // Reset
                    r.hasSchedule = false;
                    r.hasDspSchedule = false;
                    r.hasInfo = false;
                    r.scheduleID = null;
                    r.scheduleName = null;
                    r.cronExpression = null;
                    r.timezone = null;
                    r.nextRunAt = null;
                    r.isActive = false;
                    r.isPaused = false;
                    r.scheduleText = null;
                    r.typeLabel = null;
                    r.typeState = "None";
                    r.typeIcon = null;
                    r.source = null;

                    // Build full entries list (one item per persisted schedule).
                    var entries = [];
                    if (s) {
                        entries.push({
                            kind: "app",
                            scheduleID: s.ID,
                            label: "Traffic Lights",
                            description: this._formatCronHuman(s.cronExpression, s.timezone) || s.cronExpression,
                            icon: "sap-icon://play",
                            state: s.isActive ? "Success" : "None",
                            nextRunAt: s.nextRunAt,
                            isActive: !!s.isActive,
                            timezone: s.timezone,
                            spaceId: s.spaceId,
                            taskchain: s.taskchain,
                            canEdit: true,
                            canDelete: true
                        });
                    }
                    cList.forEach(function (c) {
                        var isOnDemand = c.source === "onDemand";
                        entries.push({
                            kind: c.source || "calendar",
                            calendarEntryID: c.ID,
                            label: isOnDemand ? "On demand" : "Custom calendar",
                            description: c.runDate + " " + (c.runTime || ""),
                            icon: isOnDemand ? "sap-icon://time-entry-request" : "sap-icon://appointment-2",
                            state: "Success",
                            nextRunAt: c.nextRunAt,
                            isActive: true,
                            timezone: c.timezone,
                            spaceId: c.spaceId,
                            taskchain: c.taskchain,
                            canEdit: true,
                            canDelete: true
                        });
                    });
                    if (d) {
                        var dspDesc = this._formatCronHuman(d.cronExpression, d.timezone)
                            || d.cronExpression
                            || (d.frequency ? d.frequency.charAt(0).toUpperCase() + d.frequency.slice(1).toLowerCase().replace(/_/g, " ") : "")
                            || d.description
                            || "";
                        var bDspPaused = d.isPaused === true || d.isActive === false;
                        entries.push({
                            kind: "dsp",
                            label: "Standard DSP",
                            description: dspDesc,
                            icon: "sap-icon://product",
                            state: bDspPaused ? "Warning" : "Information",
                            nextRunAt: d.nextRunAt,
                            isPaused: bDspPaused,
                            isActive: !bDspPaused,
                            timezone: d.timezone,
                            spaceId: r.spaceId,
                            taskchain: r.name,
                            canEdit: false,
                            canDelete: false
                        });
                    }
                    // Sort: earliest next-run first; entries without nextRunAt last.
                    entries.sort(function (a, b) {
                        var ta = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Infinity;
                        var tb = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Infinity;
                        return ta - tb;
                    });
                    r.entries = entries;
                    r.entriesCount = entries.length;
                    r.hasEntries = entries.length > 0;
                    // True if ANY entry comes from DSP (not just the top one)
                    r.hasDspSchedule = entries.some(function (e) { return e.kind === "dsp"; });

                    // Summary always shows the earliest (next) upcoming entry.
                    var top = entries[0];
                    if (top) {
                        r.hasInfo = true;
                        r.hasSchedule = top.kind === "app";
                        r.scheduleID = (top.kind === "app") ? top.scheduleID : null;
                        r.nextRunAt = top.nextRunAt;
                        r.isPaused = !!top.isPaused;
                        r.timezone = top.timezone;
                        r.isActive = top.isActive;
                        r.typeLabel = top.label;
                        r.typeState = top.state;
                        r.typeIcon = top.icon;
                        r.source = top.kind;
                        r.scheduleText = top.description;
                    }
                    r.schedulesLoaded = true;
                    r.filterStatus = r.isPaused ? "paused" : (r.hasInfo ? "scheduled" : "notScheduled");
                    r.filterType = ({ app: "trafficLights", onDemand: "onDemand", calendar: "customCalendar", dsp: "dsp" })[r.source] || "none";
                }.bind(this));

                this._pageModel.setProperty("/rows", rows.slice());
                this._updateSummary();
            }.bind(this)).catch(function (err) {
                console.warn("Could not load schedules:", err && err.message);
                // Mark rows as loaded even on error so the UI isn't stuck hidden
                var rows2 = this._pageModel.getProperty("/rows") || [];
                rows2.forEach(function (r) {
                    r.schedulesLoaded = true;
                    r.filterStatus = r.filterStatus || "notScheduled";
                    r.filterType = r.filterType || "none";
                });
                this._pageModel.setProperty("/rows", rows2.slice());
                this._updateSummary();
            }.bind(this));
        },

        _fetchDspSchedules: function () {
            return new Promise(function (resolve, reject) {
                fetch(this._getApiBase() + "dsp/taskchain-schedules", {
                    method: "GET",
                    headers: { "Accept": "application/json" }
                }).then(function (res) {
                    return res.text().then(function (txt) {
                        var data;
                        try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = {}; }
                        if (!res.ok) { reject(new Error((data && data.error) || ("HTTP " + res.status))); return; }
                        resolve(data);
                    });
                }).catch(reject);
            }.bind(this)).then(function (data) {
                var map = {};
                (data && data.data || []).forEach(function (s) {
                    if (!s || !s.taskchain) return;
                    map[this._rowKey(s.spaceId, s.taskchain)] = s;
                }.bind(this));
                return map;
            }.bind(this));
        },

        // ------------------------------------------------------------
        // Format helpers
        // ------------------------------------------------------------
        formatDate: function (v) {
            if (!v) return "";
            var d = (v instanceof Date) ? v : new Date(v);
            return isNaN(d.getTime()) ? String(v) : d.toLocaleString();
        },

        formatScheduleText: function (v) { return v || ""; },

        formatBusinessName: function (v) {
            if (!v) return "";
            return String(v).replace(/^\s*task\s*chain\s*[-:–]\s*/i, "");
        },

        _formatCronHuman: function (sCron, sTz) {
            if (!sCron) return "";
            var parts = String(sCron).trim().split(/\s+/);
            if (parts.length < 5) return sCron + (sTz ? " " + sTz : "");
            var m = parts[0], h = parts[1], dom = parts[2], mon = parts[3], dow = parts[4];

            function hhmm(hh, mm) {
                var H = (hh.length === 1 ? "0" + hh : hh);
                var M = (mm.length === 1 ? "0" + mm : mm);
                return H + ":" + M;
            }

            var tz = sTz ? " " + sTz : "";

            // Daily X:Y
            if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === "*" && mon === "*" && dow === "*") {
                return "Daily " + hhmm(h, m) + tz;
            }
            // Weekly on day
            var DAY = { "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu", "5": "Fri", "6": "Sat", "7": "Sun" };
            if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === "*" && mon === "*" && /^\d+$/.test(dow)) {
                return "Weekly " + (DAY[dow] || dow) + " " + hhmm(h, m) + tz;
            }
            // Monthly day N
            if (/^\d+$/.test(m) && /^\d+$/.test(h) && /^\d+$/.test(dom) && mon === "*" && dow === "*") {
                return "Monthly day " + dom + " " + hhmm(h, m) + tz;
            }
            return sCron + tz;
        },

        // ------------------------------------------------------------
        onViewSwitch: function (oEvt) {
            if (oEvt.getParameter("key") === "calendar") {
                this.getRouter().navTo("scheduleCalendar");
            }
        },

        onRefresh: function () {
            this._refreshSchedulesForRows();
        },

        _updateSummary: function () {
            var rows = this._pageModel.getProperty("/rows") || [];
            var summary = { total: rows.length, scheduled: 0, notScheduled: 0, paused: 0 };
            var aSpaces = [];
            rows.forEach(function (r) {
                if (r.filterStatus === "scheduled") summary.scheduled++;
                else if (r.filterStatus === "paused") summary.paused++;
                else summary.notScheduled++;
                if (r.spaceId && aSpaces.indexOf(r.spaceId) === -1) aSpaces.push(r.spaceId);
            });
            aSpaces.sort();
            this._pageModel.setProperty("/summary", summary);
            this._pageModel.setProperty("/spaceOptions", [{ key: "all", text: this.i18n("list.filter.spaceAll") }]
                .concat(aSpaces.map(function (s) { return { key: s, text: s }; })));

            // Re-apply the currently active filters so /filteredCount (and the
            // table's visible rows) stay in sync whenever /rows is reloaded.
            this._applyFilters();
        },

        onSearchTaskchains: function (oEvt) {
            var sQuery = (oEvt.getParameter("newValue") !== undefined
                ? oEvt.getParameter("newValue")
                : oEvt.getParameter("query")) || "";
            this._sSearchQuery = sQuery.toLowerCase().trim();
            this._applyFilters();
        },

        onFilterChange: function () {
            this._applyFilters();
        },

        _applyFilters: function () {
            var oTable = this.byId("taskchainsTable");
            if (!oTable) return;
            var oBinding = oTable.getBinding("items");
            if (!oBinding) return;

            var aFilters = [];

            var sQ = this._sSearchQuery || "";
            if (sQ) {
                aFilters.push(new Filter({
                    filters: [
                        new Filter("spaceId", FilterOperator.Contains, sQ),
                        new Filter("name", FilterOperator.Contains, sQ),
                        new Filter("businessName", FilterOperator.Contains, sQ)
                    ],
                    and: false
                }));
            }

            var sStatus = this._pageModel.getProperty("/filterStatus");
            if (sStatus && sStatus !== "all") {
                aFilters.push(new Filter("filterStatus", FilterOperator.EQ, sStatus));
            }

            var sType = this._pageModel.getProperty("/filterType");
            if (sType && sType !== "all") {
                aFilters.push(new Filter("filterType", FilterOperator.EQ, sType));
            }

            var sSpace = this._pageModel.getProperty("/filterSpace");
            if (sSpace && sSpace !== "all") {
                aFilters.push(new Filter("spaceId", FilterOperator.EQ, sSpace));
            }

            oBinding.filter(aFilters);
            this._pageModel.setProperty("/filteredCount", oBinding.getLength());
        },

        // ------------------------------------------------------------
        // "Add Task Chain" -> open DSP picker (client-side JSON model)
        // Taskchain is @cds.persistence.skip (virtual entity): NE filters
        // are not forwarded to the custom handler, so we load all items once
        // and filter client-side to exclude already-added task chains.
        // ------------------------------------------------------------
        onAddTaskchain: function () {
            var oView = this.getView();
            var rows = this._pageModel.getProperty("/rows") || [];
            var existingKeys = {};
            rows.forEach(function (r) { existingKeys[this._rowKey(r.spaceId, r.name)] = true; }.bind(this));

            var oModel = this.getModel();
            if (!oModel) return;

            if (!this._pickerModel) {
                this._pickerModel = new JSONModel({ items: [], allItems: [] });
                oView.setModel(this._pickerModel, "picker");
            }

            oModel.bindList("/Taskchain").requestContexts(0, 2000).then(function (aCtx) {
                var allItems = aCtx.map(function (c) { return c.getObject(); });
                var filtered = allItems.filter(function (o) {
                    return !existingKeys[this._rowKey(o.spaceId, o.name)];
                }.bind(this));
                this._pickerModel.setData({ items: filtered, allItems: filtered });

                if (!this._pPicker) {
                    this._pPicker = Fragment.load({
                        id: oView.getId(),
                        name: "scheduler.view.fragments.TaskchainPickerDialog",
                        controller: this
                    }).then(function (oDialog) {
                        oView.addDependent(oDialog);
                        return oDialog;
                    });
                }
                this._pPicker.then(function (oDialog) { oDialog.open(); });
            }.bind(this)).catch(function (err) {
                console.warn("[Scheduler] Could not load task chains:", err && err.message);
            });
        },

        onPickerSearch: function (oEvt) {
            var sQuery = (oEvt.getParameter("value") || oEvt.getParameter("newValue") || "").toLowerCase().trim();
            if (!this._pickerModel) return;
            var allItems = this._pickerModel.getProperty("/allItems") || [];
            var filtered = sQuery ? allItems.filter(function (o) {
                return (o.name || "").toLowerCase().indexOf(sQuery) !== -1
                    || (o.businessName || "").toLowerCase().indexOf(sQuery) !== -1
                    || (o.spaceId || "").toLowerCase().indexOf(sQuery) !== -1;
            }) : allItems;
            this._pickerModel.setProperty("/items", filtered);
        },

        onPickerConfirm: function (oEvt) {
            var aItems = oEvt.getParameter("selectedItems") || [];
            if (!aItems.length) {
                var oItem = oEvt.getParameter("selectedItem");
                if (oItem) aItems = [oItem];
            }
            if (!aItems.length) return;

            var rows = (this._pageModel.getProperty("/rows") || []).slice();
            var existing = {};
            rows.forEach(function (r) { existing[this._rowKey(r.spaceId, r.name)] = true; }.bind(this));

            var oModel = this.getModel();
            var oList = oModel.bindList("/ScheduledTaskchain");
            var aCreated = [];

            aItems.forEach(function (oI) {
                var o = (oI.getBindingContext("picker") || oI.getBindingContext()).getObject();
                var k = this._rowKey(o.spaceId, o.name);
                if (existing[k]) return;
                var newRow = {
                    spaceId: o.spaceId,
                    name: o.name,
                    businessName: o.businessName || o.name,
                    hasSchedule: false,
                    filterStatus: "notScheduled",
                    filterType: "none"
                };
                rows.push(newRow);
                existing[k] = true;
                var oCtx = oList.create({
                    spaceId: o.spaceId,
                    name: o.name,
                    businessName: o.businessName || o.name
                });
                aCreated.push(oCtx.created());
            }.bind(this));

            this._pageModel.setProperty("/rows", rows);
            this._updateSummary();
            Promise.all(aCreated).then(function () {
                this._refreshSchedulesForRows();
            }.bind(this)).catch(function (err) {
                this.error(err.message || String(err));
            }.bind(this));
        },

        onPickerClose: function () { /* nothing */ },

        // ------------------------------------------------------------
        // Row actions
        // ------------------------------------------------------------
        onEditOrSchedule: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("page");
            var row = oCtx.getObject();
            if (row.hasSchedule && row.scheduleID) {
                this._openEditExistingSchedule(row);
            } else {
                this._openNewScheduleForRow(row);
            }
        },

        onScheduleTaskchain: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("page");
            var row = oCtx.getObject();
            this._pendingRow = row;
            // Populate the edit model so the dialog can show the task chain name/space
            this._editModel.setData(Object.assign({}, EMPTY, {
                name: row.businessName || row.name,
                taskchain: row.name,
                spaceId: row.spaceId || "",
                targetType: "DSP",
                chainLocked: true
            }));
            this._openKindDialog();
        },

        // ------------------------------------------------------------
        // "Schedule kind" popup: lets the user pick between
        //   - On Demand
        //   - Custom Calendar
        //   - Traffic Lights
        // All task chains are DSP, so we only choose the *scheduling kind*.
        // ------------------------------------------------------------
        _openKindDialog: function () {
            var oView = this.getView();
            if (!this._pKindDialog) {
                this._pKindDialog = Fragment.load({
                    id: oView.getId(),
                    name: "scheduler.view.fragments.ScheduleKindDialog",
                    controller: this
                }).then(function (oDialog) {
                    oView.addDependent(oDialog);
                    oDialog.setModel(this._editModel, "edit");
                    return oDialog;
                }.bind(this));
            } else {
                // Always update the model reference in case the dialog was already loaded
                this._pKindDialog.then(function (oDialog) {
                    oDialog.setModel(this._editModel, "edit");
                }.bind(this));
            }
            this._pKindDialog.then(function (oDialog) { oDialog.open(); });
        },

        _closeKindDialog: function () {
            if (this._pKindDialog) {
                this._pKindDialog.then(function (d) { d.close(); });
            }
        },

        onCloseKindDialog: function () {
            this._closeKindDialog();
            this._pendingRow = null;
        },

        onPickKindOnDemand: function () {
            this._closeKindDialog();
            var row = this._pendingRow;
            this._pendingRow = null;
            if (!row) { console.warn("[Scheduler] no pendingRow"); return; }
            // Navigate to the dedicated On Demand page instead of opening a popup
            this.getRouter().navTo("onDemand", {
                "?query": {
                    spaceId: row.spaceId || "",
                    taskchain: row.name || "",
                    name: row.businessName || row.name || ""
                }
            });
        },

        onPickKindCustomCalendar: function () {
            this._closeKindDialog();
            var row = this._pendingRow;
            this._pendingRow = null;
            if (!row) return;
            this.getRouter().navTo("customCalendar", {
                "?query": {
                    spaceId: row.spaceId || "",
                    taskchain: row.name || "",
                    name: row.businessName || row.name || ""
                }
            });
        },

        onPickKindTrafficLights: function () {
            this._closeKindDialog();
            var row = this._pendingRow; this._pendingRow = null;
            if (!row) return;
            this.getRouter().navTo("trafficLights", {
                "?query": {
                    spaceId: row.spaceId || "",
                    taskchain: row.name || "",
                    name: row.businessName || row.name || ""
                }
            });
        },

        onEditSchedule: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("page");
            this._openEditExistingSchedule(oCtx.getObject());
        },

        // ------------------------------------------------------------
        // Schedules popover: shows every persisted schedule for a row
        // (app cron, custom calendar, on-demand, DSP), with per-entry
        // edit / delete buttons.
        // ------------------------------------------------------------
        _ensurePopoverModel: function () {
            if (!this._popoverModel) {
                this._popoverModel = new JSONModel({ title: "", row: null, entries: [] });
            }
            return this._popoverModel;
        },

        onShowSchedules: function (oEvt) {
            var oBtn = oEvt.getSource();
            var oCtx = oBtn.getBindingContext("page");
            var row = oCtx.getObject();
            var oModel = this._ensurePopoverModel();
            oModel.setData({
                title: row.businessName || row.name,
                row: row,
                entries: (row.entries || []).slice()
            });
            var oView = this.getView();
            if (!this._pSchedulesPopover) {
                this._pSchedulesPopover = Fragment.load({
                    id: oView.getId(),
                    name: "scheduler.view.fragments.SchedulesPopover",
                    controller: this
                }).then(function (oPop) {
                    oView.addDependent(oPop);
                    oPop.setModel(oModel, "popover");
                    return oPop;
                }).catch(function (e) {
                    console.error("[Scheduler] SchedulesPopover load failed", e);
                    MessageToast.show("Popover load failed: " + (e && e.message || e));
                });
            } else {
                this._pSchedulesPopover.then(function (oPop) { oPop.setModel(oModel, "popover"); });
            }
            this._pSchedulesPopover.then(function (oPop) { oPop.openBy(oBtn); });
        },

        onCloseSchedulesPopover: function () {
            if (this._pSchedulesPopover) {
                this._pSchedulesPopover.then(function (p) { p.close(); });
            }
        },

        // Navigate directly to the right scheduling page for a task chain that
        // already has a non-DSP schedule (one-type-per-chain rule).
        onDirectEditSchedule: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("page");
            var row = oCtx.getObject();
            var source = row.source; // kind of the top/representative entry

            if (source === "app") {
                // Traffic Lights / cron-based app schedule
                this.getRouter().navTo("trafficLights", {
                    "?query": {
                        spaceId: row.spaceId || "",
                        taskchain: row.name || "",
                        name: row.businessName || row.name || "",
                        scheduleID: row.scheduleID || ""
                    }
                });
            } else if (source === "calendar") {
                this.getRouter().navTo("customCalendar", {
                    "?query": {
                        spaceId: row.spaceId || "",
                        taskchain: row.name || "",
                        name: row.businessName || row.name || ""
                    }
                });
            } else if (source === "onDemand") {
                // Find the first onDemand entry to get its ID
                var onDemandEntry = (row.entries || []).find(function (e) { return e.kind === "onDemand"; });
                this.getRouter().navTo("onDemand", {
                    "?query": {
                        spaceId: row.spaceId || "",
                        taskchain: row.name || "",
                        name: row.businessName || row.name || "",
                        entryId: (onDemandEntry && onDemandEntry.calendarEntryID) || ""
                    }
                });
            }
        },

        onEditEntry: function (oEvt) {
            var oEntryCtx = oEvt.getSource().getBindingContext("popover");
            if (!oEntryCtx) return;
            var e = oEntryCtx.getObject();
            this.onCloseSchedulesPopover();
            if (e.kind === "app" && e.scheduleID) {
                this.getRouter().navTo("trafficLights", {
                    "?query": {
                        spaceId: e.spaceId || "",
                        taskchain: e.taskchain || "",
                        name: e.taskchain || "",
                        scheduleID: e.scheduleID
                    }
                });
                return;
            }
            if (e.kind === "calendar") {
                this.getRouter().navTo("customCalendar", {
                    "?query": {
                        spaceId: e.spaceId || "",
                        taskchain: e.taskchain || "",
                        name: e.taskchain || "",
                        entryId: e.calendarEntryID || ""
                    }
                });
                return;
            }
            if (e.kind === "onDemand") {
                this.getRouter().navTo("onDemand", {
                    "?query": {
                        spaceId: e.spaceId || "",
                        taskchain: e.taskchain || "",
                        name: e.taskchain || "",
                        entryId: e.calendarEntryID || ""
                    }
                });
                return;
            }
        },

        onDeleteEntry: function (oEvt) {
            var oEntryCtx = oEvt.getSource().getBindingContext("popover");
            if (!oEntryCtx) return;
            var e = oEntryCtx.getObject();
            var that = this;
            MessageBox.confirm("Delete this schedule?", {
                onClose: function (sAction) {
                    if (sAction !== MessageBox.Action.OK) return;
                    that._deleteEntry(e).then(function () {
                        that.onCloseSchedulesPopover();
                        that._refreshSchedulesForRows();
                    }).catch(function (err) {
                        that.error(err && err.message || String(err));
                    });
                }
            });
        },

        _deleteEntry: function (e) {
            var oModel = this.getModel();
            if (!oModel) return Promise.reject(new Error("No OData model"));
            var that = this;
            var sTaskchain = e.taskchain || e.name || "";

            function _clearStepParams() {
                var oComp = that.getOwnerComponent();
                if (oComp && oComp._stepParamsState && oComp._stepParamsState.taskchain === sTaskchain) {
                    oComp._stepParamsState = null;
                }
            }

            if (e.kind === "app" && e.scheduleID) {
                var oCtxBind = oModel.bindContext("/Schedule(" + this._key(e.scheduleID) + ")");
                return oCtxBind.requestObject().then(function () {
                    return oCtxBind.getBoundContext().delete();
                }).then(_clearStepParams);
            }
            if ((e.kind === "calendar" || e.kind === "onDemand") && e.calendarEntryID) {
                var oCalBind = oModel.bindContext("/ScheduleEntry(" + this._key(e.calendarEntryID) + ")");
                return oCalBind.requestObject().then(function () {
                    return oCalBind.getBoundContext().delete();
                }).then(_clearStepParams);
            }
            return Promise.reject(new Error("This schedule cannot be deleted from the app."));
        },

        onAddScheduleFromPopover: function () {
            var oModel = this._ensurePopoverModel();
            var row = oModel.getProperty("/row");
            this.onCloseSchedulesPopover();
            if (!row) return;
            this._pendingRow = row;
            this._editModel.setData(Object.assign({}, EMPTY, {
                name: row.businessName || row.name,
                taskchain: row.name,
                spaceId: row.spaceId || "",
                targetType: "DSP",
                chainLocked: true
            }));
            this._openKindDialog();
        },

        // ------------------------------------------------------------
        // On Demand dialog: choose Run Now / Run At + step parameters
        // ------------------------------------------------------------
        _openOnDemandDialog: function () {
            var oView = this.getView();
            if (!this._pOnDemandDialog) {
                this._pOnDemandDialog = Fragment.load({
                    id: oView.getId(),
                    name: "scheduler.view.fragments.OnDemandDialog",
                    controller: this
                }).then(function (oDialog) {
                    oView.addDependent(oDialog);
                    oDialog.setModel(this._editModel, "edit");
                    return oDialog;
                }.bind(this)).catch(function (e) {
                    console.error("[Scheduler] OnDemandDialog load failed", e);
                    MessageToast.show("OnDemandDialog load failed: " + (e && e.message || e));
                });
            } else {
                this._pOnDemandDialog.then(function (oDialog) {
                    oDialog.setModel(this._editModel, "edit");
                }.bind(this));
            }
            this._pOnDemandDialog.then(function (oDialog) { oDialog.open(); });
        },

        onCloseOnDemandDialog: function () {
            if (this._pOnDemandDialog) this._pOnDemandDialog.then(function (d) { d.close(); });
            this._pendingRow = null;
        },

        onConfigureStepParameters: function () {
            var d = this._editModel.getData();
            // Close any open dialog (OnDemand/CustomCalendar) before navigating away
            if (this._pOnDemandDialog) this._pOnDemandDialog.then(function (x) { x.close(); });
            if (this._pCustomCalendarDialog) this._pCustomCalendarDialog.then(function (x) { x.close(); });
            this.getRouter().navTo("stepParameters", {
                "?query": {
                    spaceId: d.spaceId || "",
                    taskchain: d.taskchain || "",
                    name: d.name || "",
                    targetType: d.targetType || "DSP",
                    jobTemplate: d.jobTemplate || "",
                    returnTo: "scheduleList"
                }
            });
        },

        onCloseStepParameters: function () {
            if (this._pStepDialog) this._pStepDialog.then(function (d) { d.close(); });
        },

        onConfirmOnDemand: function () {
            var d = this._editModel.getData();
            var row = this._pendingRow;
            if (!row) { this.onCloseOnDemandDialog(); return; }

            var parameters = null;
            if (d.parameters && String(d.parameters).trim()) {
                try { parameters = JSON.parse(d.parameters); }
                catch (e) { this.error("Step parameters must be valid JSON: " + e.message); return; }
            }

            var payload = {
                spaceId: d.spaceId,
                taskchain: d.taskchain,
                parameters: parameters
            };

            if (d.onDemandModeIndex === 0) {
                this.callScheduler("/run-now-adhoc", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                }).then(function () {
                    this.toast(this.i18n("msg.runTriggered", [d.name || d.taskchain]));
                    this.onCloseOnDemandDialog();
                }.bind(this)).catch(function (err) {
                    this.error(err.message || String(err));
                }.bind(this));
            } else {
                if (!d.onDemandDate || !d.onDemandTime) {
                    this.error("Please choose date and time");
                    return;
                }
                payload.runAt = d.onDemandDate + "T" + d.onDemandTime + ":00";
                this.callScheduler("/schedule-once", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                }).then(function () {
                    this.toast(this.i18n("msg.created", [d.name || d.taskchain]));
                    this.onCloseOnDemandDialog();
                    this._refreshSchedulesForRows();
                }.bind(this)).catch(function (err) {
                    this.error(err.message || String(err));
                }.bind(this));
            }
        },

        // ------------------------------------------------------------
        // Custom Calendar dialog: upload .xlsx with Chain|Date|Time rows
        // ------------------------------------------------------------
        formatCalendarEntriesTitle: function (sTaskchain) {
            try {
                var oRb = this.getView().getModel("i18n").getResourceBundle();
                return oRb.getText("calendar.entries", [sTaskchain || ""]);
            } catch (e) { return "Active entries for " + (sTaskchain || ""); }
        },

        _openCustomCalendarDialog: function () {
            var oView = this.getView();
            if (!this._pCustomCalendarDialog) {
                this._pCustomCalendarDialog = Fragment.load({
                    id: oView.getId(),
                    name: "scheduler.view.fragments.CustomCalendarDialog",
                    controller: this
                }).then(function (oDialog) {
                    oView.addDependent(oDialog);
                    oDialog.setModel(this._editModel, "edit");
                    return oDialog;
                }.bind(this)).catch(function (e) {
                    console.error("[Scheduler] CustomCalendarDialog load failed", e);
                    MessageToast.show("CustomCalendarDialog load failed: " + (e && e.message || e));
                });
            } else {
                this._pCustomCalendarDialog.then(function (oDialog) {
                    oDialog.setModel(this._editModel, "edit");
                }.bind(this));
            }
            this._loadCalendarEntries();
            this._pCustomCalendarDialog.then(function (oDialog) { oDialog.open(); });
        },

        onCloseCustomCalendarDialog: function () {
            if (this._pCustomCalendarDialog) {
                this._pCustomCalendarDialog.then(function (d) { d.close(); });
            }
            this._pendingRow = null;
        },

        onDownloadCalendarTemplate: function () {
            var sChain = this._editModel.getProperty("/taskchain") || "TASK_CHAIN_NAME";
            var aRows = [
                ["Chain", "Date", "Time"],
                [sChain, "2026-09-19", "04:00"],
                [sChain, "2026-09-26", "04:00"],
                [sChain, "2026-10-10", "04:00"]
            ];
            if (typeof window.XLSX === "undefined") {
                // CSV fallback
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
                    // Persist new entries to HDI then reload
                    that._persistCalendarEntries(aEntries).then(function () {
                        that._loadCalendarEntries();
                    });
                } catch (err) {
                    console.error("[Scheduler] calendar parse error", err);
                    var oRb = that.getView().getModel("i18n").getResourceBundle();
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

        _parseCalendarBuffer: function (data, sFilename) {
            // CSV path
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
            // Detect header row
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
            // yyyy-mm-dd
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
            // dd/mm/yyyy or dd-mm-yyyy
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
            ], { $select: "ID,spaceId,taskchain,runDate,runTime,timezone,active,parameters" });
            var that = this;
            return oList.requestContexts(0, 1000).then(function (aCtx) {
                var aEntries = aCtx.map(function (c) {
                    var o = c.getObject();
                    return {
                        ID: o.ID,
                        chain: o.taskchain,
                        date: o.runDate,
                        dateLabel: that._formatDateLabel(o.runDate),
                        time: (o.runTime || "00:00") + " CET",
                        rawTime: o.runTime || "00:00",
                        timezone: o.timezone || "Europe/Rome",
                        active: !!o.active,
                        parameters: o.parameters || ""
                    };
                });
                that._editModel.setProperty("/calendarEntries", aEntries);
                if (aEntries.length && !that._editModel.getProperty("/calendarFileStatus")) {
                    that._editModel.setProperty("/calendarFileStatus",
                        aEntries.length + " entries loaded from server");
                }
            }).catch(function (err) {
                console.warn("Could not load calendar entries:", err && err.message);
            });
        },

        _persistCalendarEntries: function (aEntries) {
            // Bulk create. Skips entries already in DB by ID (none for upload path).
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
                    parameters: e.parameters || ""
                });
                return oCtx.created();
            });
            return Promise.all(aPromises).catch(function (err) {
                console.warn("Could not persist calendar entries:", err && err.message);
            });
        },

        onAddCalendarEntry: function () {
            console.log("[Scheduler] onAddCalendarEntry fired");
            this._editingEntryId = null;
            var now = new Date();
            this._editModel.setProperty("/entryDate", now.toISOString().slice(0, 10));
            this._editModel.setProperty("/entryTime", "04:00");
            this._editModel.setProperty("/entryActive", true);
            this._editModel.setProperty("/entryParameters", "");
            this._openCalendarEntryDialog();
        },

        onEditCalendarEntry: function (oEvt) {
            console.log("[Scheduler] onEditCalendarEntry fired");
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) { console.warn("[Scheduler] no binding ctx for edit"); return; }
            var o = oCtx.getObject();
            this._editingEntryId = o.ID;
            this._editModel.setProperty("/entryDate", o.date);
            this._editModel.setProperty("/entryTime", o.rawTime || (o.time || "").replace(/\s*CET.*$/i, ""));
            this._editModel.setProperty("/entryActive", !!o.active);
            this._editModel.setProperty("/entryParameters", o.parameters || "");
            this._openCalendarEntryDialog();
        },

        _openCalendarEntryDialog: function () {
            console.log("[Scheduler] _openCalendarEntryDialog, editingId=", this._editingEntryId);
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
                // Update via deep-binding path
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

        onRemoveCalendarEntry: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            var o = oCtx.getObject();
            var that = this;
            var oRb = this.getView().getModel("i18n").getResourceBundle();
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

        onCalendarConfigureRowParams: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            this._calendarRowCtx = oCtx;
            this._editModel.setProperty("/parameters", oCtx.getProperty("parameters") || "");
            this.onConfigureStepParameters();
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
                    // Persist parameters to DB
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

        onConfirmCustomCalendar: function () {
            var d = this._editModel.getData();
            var aEntries = (d.calendarEntries || []).filter(function (e) { return e.active; });
            if (!aEntries.length) {
                this.error("No active entries to schedule");
                return;
            }
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
                that.toast(aEntries.length + " calendar entries scheduled for " + (d.name || d.taskchain));
                that.onCloseCustomCalendarDialog();
                that._refreshSchedulesForRows();
            }).catch(function (err) {
                that.error(err.message || String(err));
            });
        },

        _openNewScheduleForRow: function (row, sKind) {
            // All task chains are DSP. sKind is the scheduling *kind*:
            //   ON_DEMAND | CUSTOM_CALENDAR | TRAFFIC_LIGHTS
            this._editModel.setData(Object.assign({}, EMPTY, {
                name: row.businessName || row.name,
                targetType: "DSP",
                spaceId: row.spaceId || "",
                taskchain: row.name,
                chainLocked: true,
                scheduleKind: sKind || "ON_DEMAND"
            }));
            this._previewModel.setProperty("/next", []);
            this._openEditDialog();
        },

        _openEditExistingSchedule: function (row) {
            if (!row.scheduleID) return;
            var oModel = this.getModel();
            var sPath = "/Schedule(" + this._key(row.scheduleID) + ")";
            var b = oModel.bindContext(sPath);
            b.requestObject().then(function (obj) {
                this._editModel.setData(Object.assign({}, EMPTY, obj, { chainLocked: true }));
                this._previewModel.setProperty("/next", []);
                this._openEditDialog();
            }.bind(this)).catch(function (err) { this.error(err.message); }.bind(this));
        },

        onRemoveRow: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("page");
            var row = oCtx.getObject();
            var sName = row.name;
            var doRemove = function () {
                var rows = (this._pageModel.getProperty("/rows") || []).filter(function (r) {
                    return !(r.spaceId === row.spaceId && r.name === row.name);
                });
                this._pageModel.setProperty("/rows", rows);
                this._updateSummary();
                this._deleteSavedRow(row.spaceId, row.name);
            }.bind(this);

            if (!row.hasSchedule) { doRemove(); return; }
            MessageBox.confirm(this.i18n("msg.confirmRemoveRow", [sName]), {
                onClose: function (sAction) {
                    if (sAction === MessageBox.Action.OK) doRemove();
                }
            });
        },

        _deleteSavedRow: function (sSpaceId, sName) {
            var oModel = this.getModel();
            if (!oModel) return;
            var oList = oModel.bindList("/ScheduledTaskchain", undefined, undefined, [
                new Filter("spaceId", FilterOperator.EQ, sSpaceId),
                new Filter("name", FilterOperator.EQ, sName)
            ]);
            oList.requestContexts(0, 1).then(function (aCtx) {
                if (aCtx && aCtx[0]) {
                    aCtx[0].delete().catch(function (err) {
                        console.warn("Could not delete saved task chain:", err && err.message);
                    });
                }
            }).catch(function (err) {
                console.warn("Could not locate saved task chain:", err && err.message);
            });
        },

        onRunNow: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("page");
            var row = oCtx.getObject();
            if (!row.scheduleID) return;
            this.callScheduler("/run-now/" + row.scheduleID, { method: "POST" })
                .then(function () {
                    this.toast(this.i18n("msg.runTriggered", [row.scheduleName || row.name]));
                    setTimeout(this._refreshSchedulesForRows.bind(this), 1500);
                }.bind(this))
                .catch(function (err) { this.error(err.message); }.bind(this));
        },

        // ------------------------------------------------------------
        // Schedule edit dialog
        // ------------------------------------------------------------
        _openEditDialog: function () {
            var oView = this.getView();
            if (!this._pDialog) {
                this._pDialog = Fragment.load({
                    id: oView.getId(),
                    name: "scheduler.view.fragments.ScheduleEditDialog",
                    controller: this
                }).then(function (oDialog) {
                    oView.addDependent(oDialog);
                    oDialog.setModel(this._editModel, "edit");
                    oDialog.setModel(this._previewModel, "preview");
                    return oDialog;
                }.bind(this));
            }
            this._pDialog.then(function (oDialog) { oDialog.open(); });
        },

        onCloseDialog: function () {
            this._pDialog && this._pDialog.then(function (d) { d.close(); });
        },

        onPreviewCron: function () {
            var d = this._editModel.getData();
            this._previewModel.setProperty("/busy", true);
            var qs = "?cron=" + encodeURIComponent(d.cronExpression || "")
                   + "&tz="   + encodeURIComponent(d.timezone || "Europe/Rome")
                   + "&count=5";
            this.callScheduler("/preview" + qs)
                .then(function (res) {
                    this._previewModel.setProperty("/next", res.next || []);
                }.bind(this))
                .catch(function (err) {
                    this.error(this.i18n("msg.cronInvalid", [err.message]));
                    this._previewModel.setProperty("/next", []);
                }.bind(this))
                .finally(function () { this._previewModel.setProperty("/busy", false); }.bind(this));
        },

        onSave: function () {
            var d = this._editModel.getData();
            if (!d.name || !d.cronExpression || !d.targetType) {
                this.error("Name, target type and cron are required");
                return;
            }
            var oModel = this.getModel();
            var oList = oModel.bindList("/Schedule");

            var payload = {
                name: d.name, description: d.description,
                targetType: d.targetType, spaceId: d.spaceId, taskchain: d.taskchain,
                jobTemplate: d.jobTemplate, parameters: d.parameters,
                cronExpression: d.cronExpression, timezone: d.timezone,
                isActive: !!d.isActive
            };

            var p;
            if (d.ID) {
                var b = oModel.bindContext("/Schedule(" + this._key(d.ID) + ")");
                p = b.requestObject().then(function () {
                    Object.keys(payload).forEach(function (k) {
                        b.getBoundContext().setProperty(k, payload[k]);
                    });
                    return oModel.submitBatch(oModel.getUpdateGroupId());
                });
            } else {
                var oCtxNew = oList.create(payload);
                p = oCtxNew.created();
            }

            p.then(function () {
                this.toast(d.ID ? this.i18n("msg.updated", [d.name]) : this.i18n("msg.created", [d.name]));
                this.onCloseDialog();
                this._refreshSchedulesForRows();
            }.bind(this)).catch(function (err) {
                this.error(err.message || String(err));
            }.bind(this));
        },

        _key: function (id) { return id ? ("'" + id + "'") : ""; }
    });
});
