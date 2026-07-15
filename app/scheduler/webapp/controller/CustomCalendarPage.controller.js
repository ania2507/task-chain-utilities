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
                activeFutureCount: 0,
                totalCount: 0,
                visibleEntriesCount: 0,
                unsavedCount: 0,
                pendingDeleteIds: [],
                nextRunLabel: "",
                lastRunAt: null,
                lastRunStatus: "",
                showPastEntries: false,
                filterDateFrom: null,
                filterDateTo: null,
                busy: false,
                calendarUploadBusy: false,
                lastUploadFileName: ""
            });
            this.getView().setModel(oModel, "edit");
            this._editModel = oModel;
            this.getRouter().getRoute("customCalendar").attachPatternMatched(this._onMatched, this);
        },

        _onMatched: function (oEvent) {
            var oArgs = oEvent.getParameter("arguments") || {};
            var oQuery = oArgs["?query"] || {};

            // Returning from Configure Step Parameters — restore the full local state
            // (including any not-yet-saved staged entries) instead of resetting and
            // reloading from the server, which would silently drop unsaved entries.
            var oComp = this.getOwnerComponent();
            var savedState = oComp && oComp._customCalendarState;
            if (savedState && savedState.taskchain === (oQuery.taskchain || "")
                    && savedState.spaceId === (oQuery.spaceId || "")) {
                oComp._customCalendarState = null;
                this._editModel.setData(savedState);
                this._consumeStepParametersResult();
                this._loadLastRun(savedState.spaceId, savedState.taskchain);
                return;
            }

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
                activeFutureCount: 0,
                totalCount: 0,
                visibleEntriesCount: 0,
                unsavedCount: 0,
                pendingDeleteIds: [],
                nextRunLabel: "",
                lastRunAt: null,
                lastRunStatus: "",
                showPastEntries: false,
                filterDateFrom: null,
                filterDateTo: null,
                busy: false,
                calendarUploadBusy: false,
                lastUploadFileName: ""
            });
            var that = this;
            this._consumeStepParametersResult().then(function () {
                that._loadCalendarEntries();
            });
            this._loadLastRun(oQuery.spaceId, oQuery.taskchain);
        },

        // "Last Run" panel data comes directly from DSP's task execution
        // logs (v1/dsp/taskchain-runs), not from our own bookkeeping.
        _loadLastRun: function (spaceId, taskchain) {
            if (!spaceId || !taskchain) {
                this._editModel.setProperty("/lastRunAt", null);
                this._editModel.setProperty("/lastRunStatus", "");
                return;
            }
            var sUrl = this._getApiBase() + "dsp/taskchain-runs?spaceId=" + encodeURIComponent(spaceId)
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
            this._editModel.setProperty("/activeFutureCount",
                aActive.filter(function (e) { return !e.isPast; }).length);

            var nUnsaved = aEntries.filter(function (e) { return e._unsaved; }).length;
            var nPendingDelete = (this._editModel.getProperty("/pendingDeleteIds") || []).length;
            this._editModel.setProperty("/unsavedCount", nUnsaved + nPendingDelete);

            // Keep the status message in sync with the current entry count —
            // it must never show a stale number after an add/delete/save.
            if (nUnsaved > 0) {
                var sFileName = this._editModel.getProperty("/lastUploadFileName");
                var sPrefix = sFileName ? (sFileName + " — ") : "";
                this._editModel.setProperty("/calendarFileStatus",
                    sPrefix + nUnsaved + " entries loaded (not yet saved). "
                    + "Click \"Save Calendar\" to save and schedule them.");
            } else if (aEntries.length > 0) {
                var nUpcoming = aActive.filter(function (e) { return !e.isPast; }).length;
                this._editModel.setProperty("/calendarFileStatus", nUpcoming + " active entries scheduled to run");
            } else {
                this._editModel.setProperty("/calendarFileStatus", "");
            }

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

        formatCalendarFileStatusState: function (sStatus, nUnsavedCount) {
            if (!sStatus) return "None";
            if (nUnsavedCount > 0) return "Error";
            return "Success";
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

        onOpenOnDemand: function () {
            var d = this._editModel.getData();
            this.getRouter().navTo("onDemand", {
                "?query": {
                    spaceId: d.spaceId || "",
                    taskchain: d.taskchain || "",
                    name: d.name || d.taskchain || "",
                    runNowOnly: "1",
                    returnTo: "customCalendar"
                }
            });
        },

        // ------------------------------------------------------------
        // Template / upload
        // ------------------------------------------------------------
        // The XLSX (SheetJS) library is vendored under this component's own
        // "thirdparty" folder and normally loaded via a <script> tag in this
        // app's own index.html. When the scheduler component is embedded inside
        // a different shell (e.g. the "home" app), that shell's own index.html
        // is what's bootstrapped instead, so window.XLSX is never loaded —
        // fetch it dynamically here, resolved against this component's own
        // resource root so it works regardless of which shell hosts it.
        _ensureXlsxLoaded: function () {
            if (window.XLSX && window.XLSX.utils) return Promise.resolve();
            if (this._pXlsxLoad) return this._pXlsxLoad;
            var sUrl = sap.ui.require.toUrl("scheduler/thirdparty/xlsx.full.min.js");
            var that = this;
            this._pXlsxLoad = new Promise(function (resolve, reject) {
                // SheetJS's UMD wrapper checks for a global AMD-style `define` and,
                // if found, registers itself as a lazy AMD module instead of
                // populating window.XLSX — which leaves window.XLSX as an empty
                // shell (no .utils) since nothing ever requires that module. UI5's
                // core loader always exposes such a `define` once bootstrapped, so
                // hide it while this script runs to force the plain "assign to
                // window" fallback path in xlsx's UMD footer instead.
                var savedDefine = window.define;
                window.define = undefined;
                var script = document.createElement("script");
                script.src = sUrl;
                script.onload = function () {
                    window.define = savedDefine;
                    if (window.XLSX && window.XLSX.utils) {
                        resolve();
                    } else {
                        reject(new Error("XLSX script loaded but window.XLSX.utils is missing"));
                    }
                };
                script.onerror = function () {
                    window.define = savedDefine;
                    reject(new Error("Failed to load XLSX library from " + sUrl));
                };
                document.head.appendChild(script);
            }).catch(function (err) {
                // Don't cache a failed attempt — let the next call retry.
                that._pXlsxLoad = null;
                throw err;
            });
            return this._pXlsxLoad;
        },

        onDownloadCalendarTemplate: function () {
            var sChain = this._editModel.getProperty("/taskchain") || "TASK_CHAIN_NAME";
            var that = this;

            function downloadCsvFallback() {
                var sCsv = [
                    ["ID", "Chain", "Date", "Time", "Details"].join(","),
                    [1, sChain, "2026-09-19", "04:00", ""].join(",")
                ].join("\n");
                that._downloadBlob(new Blob([sCsv], { type: "text/csv" }), "calendar_template.csv");
            }

            this._ensureXlsxLoaded().then(function () {
                that._buildAndDownloadXlsxTemplate(sChain);
            }).catch(function (err) {
                console.error("[Scheduler] Could not load XLSX library:", err && err.message);
                downloadCsvFallback();
            });
        },

        _buildAndDownloadXlsxTemplate: function (sChain) {
            var XLSX = window.XLSX;
            var wb = XLSX.utils.book_new();

            // Calendar sheet
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
                ["ID", "Chain", "Date", "Time", "Details"],
                [1, sChain, "2026-09-19", "04:00", ""],
                [2, sChain, "2026-09-26", "04:00", ""],
                [3, sChain, "2026-10-10", "04:00", ""]
            ]), "Calendar");

            // Parameters sheet — static example rows.
            // IBP Step filled → IBP param; IBP Step blank → SAC param.
            // "Job Template / Multi Action" overrides what's auto-detected from DSP for
            // that DSP step — leave blank to keep using DSP's auto-detected value.
            // Replace DSP Step names, IBP Step names and values with your actual configuration.
            var aIds = [1, 2, 3];
            var aParamRows = [["Schedule ID", "DSP Step", "Job Template / Multi Action", "IBP Step", "Parameter", "Value", "HierarchyId"]];
            aIds.forEach(function (id) {
                // IBP examples
                aParamRows.push([id, "APITask_IBP", "SAP_IBP_PROC_COPY_OPERATOR", "IBP_STEP_NAME_1", "$G_SORG",      "BE40", ""]);
                aParamRows.push([id, "APITask_IBP", "SAP_IBP_PROC_COPY_OPERATOR", "IBP_STEP_NAME_2", "$G_FCSTTYPE",  "U",    ""]);
                // SAC examples (IBP Step blank)
                aParamRows.push([id, "APITask_SAC", "t.F:A8B06D852F1681322AE35493186B1970", "", "PlanningVersion", "public.Curr_FCST", ""]);
                aParamRows.push([id, "APITask_SAC", "t.F:A8B06D852F1681322AE35493186B1970", "", "Legal_Entity",    "BE40",              ""]);
                aParamRows.push([id, "APITask_SAC", "t.F:A8B06D852F1681322AE35493186B1970", "", "Product",         "*",                 "parentId"]);
                aParamRows.push([id, "APITask_SAC", "t.F:A8B06D852F1681322AE35493186B1970", "", "Profit_Center",   "*",                 "parentId"]);
                aParamRows.push([id, "APITask_SAC", "t.F:A8B06D852F1681322AE35493186B1970", "", "Date",            "202606",            ""]);
            });
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aParamRows), "Parameters");

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

        // The FileUploader is kept hidden and triggered from a plain sap.m.Button
        // instead — buttonOnly mode renders its own internal wrapper/button that
        // doesn't align vertically with sibling Buttons in the same HBox.
        onUploadButtonPress: function () {
            var oFileUploader = this.byId("customCalendarPageFileUploader");
            if (oFileUploader) {
                oFileUploader.$().find("input[type=file]").trigger("click");
            }
        },

        onCalendarFileSelect: function (oEvt) {
            var oFile = oEvt.getParameter("files") && oEvt.getParameter("files")[0];
            if (!oFile) return;
            var that = this;
            this._editModel.setProperty("/calendarUploadBusy", true);
            var bIsCsv = /\.csv$/i.test(oFile.name);
            var pReady = bIsCsv ? Promise.resolve() : this._ensureXlsxLoaded();
            pReady.then(function () {
                that._readCalendarFile(oFile, bIsCsv);
            }).catch(function (err) {
                that._editModel.setProperty("/calendarUploadBusy", false);
                console.error("[Scheduler] Could not load XLSX library:", err && err.message);
                MessageBox.error("Could not load the XLSX library needed to read this file. Use a .csv file instead.");
            });
        },

        _readCalendarFile: function (oFile, bIsCsv) {
            var that = this;
            var reader = new FileReader();
            reader.onload = function (e) {
                var oParsed;
                try {
                    oParsed = that._parseCalendarBuffer(e.target.result, oFile.name);
                } catch (err) {
                    that._editModel.setProperty("/calendarUploadBusy", false);
                    console.error("[Scheduler] calendar parse error", err);
                    var oRb = that.getResourceBundle();
                    MessageBox.error(oRb.getText("calendar.parseError", [err.message || String(err)]));
                    return;
                }

                var sChain = that._editModel.getProperty("/taskchain");

                // If the file has the new flat SAC sheet and/or Job Template/Multi Action
                // overrides, fetch step definitions — needed to (a) inject __sacMultiActionId
                // for flat SAC steps and (b) tell IBP-vs-SAC overrides apart via each DSP
                // step's own authoritative "integration": "ibp"|"sac" field.
                var oOverridesByKey = oParsed.overridesByKey || {};
                var pStepMap = Promise.resolve({ maById: {}, integrationById: {} });
                if ((oParsed.sacFlatDspSteps && oParsed.sacFlatDspSteps.length) || Object.keys(oOverridesByKey).length) {
                    var sSpaceId = that._editModel.getProperty("/spaceId") || "";
                    pStepMap = fetch(that._getApiBase() + "dsp/taskchain-steps?spaceId=" + encodeURIComponent(sSpaceId)
                        + "&taskchain=" + encodeURIComponent(sChain))
                        .then(function (r) { return r.json(); })
                        .then(function (d) {
                            var oMap = {};
                            var oIntegrationMap = {};
                            ((d && d.steps) || []).forEach(function (s) {
                                if (!s.objectId) return;
                                if (s.sacMultiActionId) oMap[s.objectId] = s.sacMultiActionId;
                                if (s.integrationType) oIntegrationMap[s.objectId] = s.integrationType;
                            });
                            return { maById: oMap, integrationById: oIntegrationMap };
                        })
                        .catch(function () { return { maById: {}, integrationById: {} }; });
                }

                pStepMap.then(function (oStepMeta) {
                    var oStepMaMap = oStepMeta.maById || {};
                    var oIntegrationMap = oStepMeta.integrationById || {};

                    // Resolve each Job Template / Multi Action override into the right
                    // sentinel(s), using the DSP step's own integration type as the
                    // authoritative signal (falls back to the row's IBP Step hint when
                    // DSP didn't report an integration type for that step).
                    Object.keys(oOverridesByKey).forEach(function (sKey) {
                        var parts = sKey.split("::");
                        var schId = parts[0], dspStep = parts[1];
                        var ov = oOverridesByKey[sKey];
                        var aList = oParsed.paramsByScheduleId[schId] && oParsed.paramsByScheduleId[schId][dspStep];
                        if (!aList) return;
                        var sIntegration = oIntegrationMap[dspStep] || "";
                        var bIsIbp = sIntegration ? sIntegration === "ibp" : ov.hintIbp;
                        if (bIsIbp) {
                            aList.push({ key: "__ibpTemplateNameOverride", value: ov.value, active: true });
                        } else {
                            aList.push({ key: "__sacMultiActionIdOverride", value: ov.value, active: true });
                            aList.push({ key: "__sacMultiActionId", value: ov.value, active: true });
                            // An explicit override makes auto-detection unnecessary for this step.
                            var iIdx = oParsed.sacFlatDspSteps.indexOf(dspStep);
                            if (iIdx !== -1) oParsed.sacFlatDspSteps.splice(iIdx, 1);
                        }
                    });

                    // Inject __sacMultiActionId sentinel for flat SAC steps
                    (oParsed.sacFlatDspSteps || []).forEach(function (sDspStep) {
                        var sSacMaId = oStepMaMap[sDspStep] || "";
                        if (!sSacMaId) return;
                        Object.keys(oParsed.paramsByScheduleId).forEach(function (schId) {
                            var aList = oParsed.paramsByScheduleId[schId][sDspStep];
                            if (!aList) return;
                            var hasSentinel = aList.some(function (p) { return p.key === "__sacMultiActionId"; });
                            if (!hasSentinel) aList.push({ key: "__sacMultiActionId", value: sSacMaId, active: true });
                        });
                    });

                    var aAllEntries = that._buildCalendarEntries(oParsed.rows, sChain, oParsed.paramsByScheduleId);

                    // Ignore past entries from the file — they are historical records already in the DB
                    var now = new Date();
                    var aEntries = aAllEntries.filter(function (entry) {
                        var sT = entry.rawTime || "00:00";
                        var dt = new Date(entry.date + "T" + (sT.length === 5 ? sT + ":00" : sT));
                        return dt >= now;
                    });

                    // Check 1: intra-file duplicates (same date+time in the file itself)
                    var oFileSeen = {};
                    var aFileDups = [];
                    aEntries.forEach(function (entry) {
                        var sKey = entry.date + "T" + entry.rawTime;
                        if (oFileSeen[sKey]) {
                            aFileDups.push(entry.dateLabel + " " + entry.rawTime);
                        }
                        oFileSeen[sKey] = true;
                    });
                    if (aFileDups.length) {
                        that._editModel.setProperty("/calendarUploadBusy", false);
                        MessageBox.error(
                            "The file contains duplicate date/time combinations:\n" +
                            aFileDups.slice(0, 5).join("\n") +
                            (aFileDups.length > 5 ? "\n…and " + (aFileDups.length - 5) + " more" : "")
                        );
                        return;
                    }

                    // Check 2: collision with future entries already on the app (same date+time)
                    // Past entries in the app are never touched by an upload
                    var aExisting = that._editModel.getProperty("/calendarEntries") || [];
                    var oAppByKey = {};
                    aExisting.filter(function (e) { return !e.isPast; }).forEach(function (entry) {
                        oAppByKey[entry.date + "T" + (entry.rawTime || "")] = entry;
                    });
                    var aCollisions = aEntries.filter(function (entry) {
                        return !!oAppByKey[entry.date + "T" + entry.rawTime];
                    });

                    function doUpload() {
                        // Nothing is persisted to the server here — the file's entries are
                        // only staged locally (in /calendarEntries) until the user clicks
                        // "Save Calendar". Entries already saved that collide with a row in
                        // the file are removed from view now, but the actual server-side
                        // delete + rescheduling only happens on Save too.
                        var aCollidingExisting = aCollisions.map(function (entry) {
                            return oAppByKey[entry.date + "T" + entry.rawTime];
                        }).filter(Boolean);
                        var aOverwriteIds = aCollidingExisting.map(function (e) { return e.ID; }).filter(Boolean);
                        if (aOverwriteIds.length) {
                            var aPending = (that._editModel.getProperty("/pendingDeleteIds") || []).concat(aOverwriteIds);
                            that._editModel.setProperty("/pendingDeleteIds", aPending);
                        }

                        var aStaged = aEntries.map(function (e) {
                            return Object.assign({}, e, {
                                ID: null,
                                isPast: false,
                                runStatus: "",
                                runAt: null,
                                _remoteId: "",
                                _unsaved: true
                            });
                        });
                        var oOverwriteIdSet = {};
                        aOverwriteIds.forEach(function (id) { oOverwriteIdSet[id] = true; });
                        var aRemaining = (that._editModel.getProperty("/calendarEntries") || [])
                            .filter(function (e) { return !e.ID || !oOverwriteIdSet[e.ID]; });
                        that._editModel.setProperty("/calendarEntries", aRemaining.concat(aStaged));
                        that._editModel.setProperty("/lastUploadFileName", oFile.name);
                        that._updateSummary();
                        that._applyPastFilter();
                    }

                    that._editModel.setProperty("/calendarUploadBusy", false);

                    if (aCollisions.length) {
                        var aLabels = aCollisions.slice(0, 5).map(function (e) {
                            return e.dateLabel + " " + e.rawTime;
                        });
                        MessageBox.warning(
                            aCollisions.length + " date/time slot" +
                            (aCollisions.length > 1 ? "s" : "") +
                            " in the file already exist on the app:\n" +
                            aLabels.join("\n") +
                            (aCollisions.length > 5 ? "\n…and " + (aCollisions.length - 5) + " more" : "") +
                            "\n\nProceed and overwrite the conflicting entries?",
                            {
                                actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                                emphasizedAction: MessageBox.Action.OK,
                                onClose: function (sAction) {
                                    if (sAction === MessageBox.Action.OK) doUpload();
                                }
                            }
                        );
                    } else {
                        doUpload();
                    }
                }).catch(function (err) {
                    console.error("[Scheduler] calendar upload error", err);
                    MessageBox.error(String(err.message || err));
                });
            };
            reader.onerror = function () { MessageBox.error("Could not read file"); };
            if (bIsCsv) {
                reader.readAsText(oFile);
            } else {
                reader.readAsArrayBuffer(oFile);
            }
        },

        _parseCalendarBuffer: function (data) {
            if (typeof data === "string") {
                return {
                    rows: data.split(/\r?\n/).filter(Boolean).map(function (line) {
                        return line.split(/[,;\t]/).map(function (s) { return s.trim(); });
                    }),
                    paramsByScheduleId: {}
                };
            }
            if (typeof window.XLSX === "undefined") {
                throw new Error("XLSX library not loaded. Use a .csv file instead.");
            }
            var XLSX = window.XLSX;
            var wb = XLSX.read(new Uint8Array(data), { type: "array", cellDates: true });

            // Sheet 1 (Calendar)
            // raw: true (not dateNF-formatted strings) — a single dateNF applied to the
            // whole sheet would also hit genuine Excel "time only" cells in the Time
            // column, turning "02:00" into a date-only string like "1899-12-30" and
            // silently making every row look invalid/past. Date/Time cells come back
            // as native JS Date objects (thanks to cellDates: true above) and are
            // formatted explicitly per-column in _buildCalendarEntries instead.
            var ws = wb.Sheets[wb.SheetNames[0]];
            var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

            // paramsByScheduleId: { scheduleId: { dspStepId: [{key, value, active, step?, hierarchyId?}] } }
            var oBySchId = {};
            var aSacFlatDspSteps = [];
            // Job Template / Multi Action override, collected once per (scheduleId, dspStep)
            // regardless of how many parameter rows reference that step.
            var oOverrideByKey = {}; // "schId::dspStep" -> { value, isIbp }
            // The same IBP Step name can repeat within one (scheduleId, dspStep) block
            // when a job template calls the same operator more than once — rows for the
            // same occurrence are consecutive (e.g. two parameter rows for one step),
            // and a later, non-consecutive repeat of the same name starts a new
            // occurrence. This mirrors exactly how the template's own step order is
            // walked when restoring, so "the Nth time this name appears in the file"
            // lines up with "the Nth time it appears in the template".
            var oIbpOccState = {}; // "schId::dspStep" -> { lastName, counts: {name: n} }

            // Parameters sheet: Schedule ID | DSP Step | Job Template / Multi Action | IBP Step | Parameter | Value | HierarchyId
            // IBP Step filled → IBP param (with step field); IBP Step blank → SAC param.
            // The "Job Template / Multi Action" column is optional (older template files
            // won't have it) — when present, it overrides what DSP auto-detects for that step.
            if (wb.SheetNames.indexOf("Parameters") !== -1) {
                var wsP = wb.Sheets["Parameters"];
                var aPRows = XLSX.utils.sheet_to_json(wsP, { header: 1, raw: false });
                var aHeader = (aPRows[0] || []).map(function (h) { return String(h || "").trim().toLowerCase(); });
                var bHasOverrideCol = aHeader.indexOf("job template / multi action") !== -1;
                var iOverrideCol = bHasOverrideCol ? 2 : -1;
                var iIbpStepCol = bHasOverrideCol ? 3 : 2;
                var iKeyCol = bHasOverrideCol ? 4 : 3;
                var iValCol = bHasOverrideCol ? 5 : 4;
                var iHIdCol = bHasOverrideCol ? 6 : 5;
                for (var pi = 1; pi < aPRows.length; pi++) {
                    var rp = aPRows[pi] || [];
                    var sP_SchId   = String(rp[0] || "").trim();
                    var sP_DspStep = String(rp[1] || "").trim();
                    var sP_Override = iOverrideCol !== -1 ? String(rp[iOverrideCol] || "").trim() : "";
                    var sP_IbpStep = String(rp[iIbpStepCol] || "").trim();
                    var sP_Key     = String(rp[iKeyCol] || "").trim();
                    var sP_Val     = String(rp[iValCol] || "").trim();
                    var sP_HId     = String(rp[iHIdCol] || "").trim();
                    if (!sP_SchId || !sP_DspStep) continue;
                    // A row is only meaningful with a param key OR a template/multiaction
                    // override — a template-only row (no Parameter/Value) must still be
                    // kept so the association itself gets saved.
                    if (!sP_Key && !sP_Override) continue;
                    if (!oBySchId[sP_SchId]) oBySchId[sP_SchId] = {};
                    if (!oBySchId[sP_SchId][sP_DspStep]) oBySchId[sP_SchId][sP_DspStep] = [];
                    if (sP_Key) {
                        var oP = { key: sP_Key, value: sP_Val, active: true };
                        if (sP_IbpStep) {
                            oP.step = sP_IbpStep;
                            var sOccKey = sP_SchId + "::" + sP_DspStep;
                            if (!oIbpOccState[sOccKey]) oIbpOccState[sOccKey] = { lastName: null, counts: {} };
                            var oOccState = oIbpOccState[sOccKey];
                            if (sP_IbpStep !== oOccState.lastName) {
                                oOccState.counts[sP_IbpStep] = (oOccState.counts[sP_IbpStep] === undefined)
                                    ? 0 : oOccState.counts[sP_IbpStep] + 1;
                                oOccState.lastName = sP_IbpStep;
                            }
                            oP.stepOccurrence = oOccState.counts[sP_IbpStep];
                        } else {
                            if (sP_HId) oP.hierarchyId = sP_HId;
                            if (aSacFlatDspSteps.indexOf(sP_DspStep) === -1) aSacFlatDspSteps.push(sP_DspStep);
                        }
                        oBySchId[sP_SchId][sP_DspStep].push(oP);
                    }
                    if (sP_Override) {
                        // Row-level IBP Step presence is only a hint here — the authoritative
                        // signal is the DSP step's own "integration": "ibp"|"sac" field, applied
                        // later in _readCalendarFile once that metadata has been fetched.
                        oOverrideByKey[sP_SchId + "::" + sP_DspStep] = { value: sP_Override, hintIbp: !!sP_IbpStep };
                    }
                }
            }

            return {
                rows: rows,
                paramsByScheduleId: oBySchId,
                sacFlatDspSteps: aSacFlatDspSteps,
                overridesByKey: oOverrideByKey
            };
        },

        _buildCalendarEntries: function (aRows, sChain, oParamsByScheduleId) {
            if (!aRows || !aRows.length) return [];
            var first = aRows[0].map(function (s) { return String(s || "").toLowerCase().trim(); });
            var bHasId = first[0] === "id" || first[0] === "schedule id";
            var iIdCol    = bHasId ? 0 : -1;
            var iChainCol = bHasId ? 1 : 0;
            var iDateCol  = bHasId ? 2 : 1;
            var iTimeCol  = bHasId ? 3 : 2;
            var iDetailsCol = first.indexOf("details");
            var iStart    = (bHasId || first.indexOf("chain") !== -1 || first.indexOf("date") !== -1) ? 1 : 0;
            var aOut = [];
            var today = new Date(); today.setHours(0, 0, 0, 0);
            for (var i = iStart; i < aRows.length; i++) {
                var r = aRows[i] || [];
                var sId  = iIdCol >= 0 ? String(r[iIdCol] || "").trim() : String(i - iStart + 1);
                var chain = String(r[iChainCol] || "").trim();
                if (!chain) continue;
                if (sChain && chain !== sChain) continue;
                var rawDate = r[iDateCol];
                var time = this._toHHMM(r[iTimeCol]);
                var d = this._toIsoDate(rawDate);
                if (!d) continue;
                var dt = new Date(d + "T" + (time.length === 5 ? time + ":00" : time));
                var oEntryParams = oParamsByScheduleId && oParamsByScheduleId[sId];
                aOut.push({
                    chain: chain,
                    date: d,
                    dateLabel: this._formatDateLabel(d),
                    time: time + " CET",
                    rawTime: time,
                    timezone: "Europe/Rome",
                    active: dt >= today,
                    parameters: oEntryParams ? JSON.stringify(oEntryParams) : "",
                    details: iDetailsCol !== -1 ? String(r[iDetailsCol] || "").trim() : ""
                });
            }
            return aOut;
        },

        // Extract "HH:mm" from a cell value that may be a native JS Date (genuine
        // Excel "time" cells, read raw thanks to cellDates: true) or plain text.
        _toHHMM: function (v) {
            if (!v) return "00:00";
            if (v instanceof Date && !isNaN(v)) {
                return ("0" + v.getHours()).slice(-2) + ":" + ("0" + v.getMinutes()).slice(-2);
            }
            return String(v).trim();
        },

        _toIsoDate: function (v) {
            if (!v) return null;
            if (v instanceof Date && !isNaN(v)) {
                return v.getFullYear() + "-" +
                    ("0" + (v.getMonth() + 1)).slice(-2) + "-" +
                    ("0" + v.getDate()).slice(-2);
            }
            var s = String(v).trim();
            // ISO yyyy-MM-dd
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
            // d1/d2/yyyy or d1/d2/yy — detect American (MM/DD) vs European (DD/MM) by checking
            // which part exceeds 12 (only valid as a day, not a month).
            var m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
            if (m) {
                var yyyy = m[3].length === 2 ? ("20" + m[3]) : m[3];
                var p1 = parseInt(m[1], 10), p2 = parseInt(m[2], 10);
                var month, day;
                if (p2 > 12) {
                    // p2 can only be a day → American format M/DD/YY
                    month = p1; day = p2;
                } else {
                    // European format DD/MM/YYYY (default)
                    month = p2; day = p1;
                }
                return yyyy + "-" + ("0" + month).slice(-2) + "-" + ("0" + day).slice(-2);
            }
            // yyyy/MM/dd
            var m2 = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
            if (m2) return m2[1] + "-" + ("0" + m2[2]).slice(-2) + "-" + ("0" + m2[3]).slice(-2);
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
                $select: "ID,spaceId,taskchain,runDate,runTime,timezone,active,parameters,details,source",
                $expand: "runs($select=status,triggeredAt,finishedAt,errorMessage,remoteId)"
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
                        details: o.details || "",
                        isPast: !isNaN(dt.getTime()) && dt < now,
                        runStatus: oLastRun ? (oLastRun.status || "") : "",
                        runAt: oLastRun ? (oLastRun.finishedAt || oLastRun.triggeredAt) : null,
                        _remoteId: oLastRun ? (oLastRun.remoteId || "") : ""
                    };
                });
                that._editModel.setProperty("/calendarEntries", aEntries);
                that._editModel.setProperty("/lastUploadFileName", "");
                that._updateSummary();
                that._applyPastFilter();
                that._editModel.setProperty("/busy", false);

                // Enrich past entries with real DSP run status
                var aPast = aEntries.filter(function (e) { return e.isPast; });
                if (aPast.length) {
                    // Entries with a remoteId → query DSP directly by logId for accurate status
                    var aRemotePromises = aPast
                        .filter(function (e) { return e._remoteId; })
                        .map(function (oEntry) {
                            var sLogId = (oEntry._remoteId || "").split("__")[1] || "";
                            if (!sLogId) return Promise.resolve();
                            return fetch(that._getApiBase() + "dsp/taskchain-runs?runId=" + encodeURIComponent(sLogId),
                                { headers: { "Accept": "application/json" } })
                                .then(function (res) { return res.json(); })
                                .then(function (data) {
                                    var r = (data && data.success && data.runs && data.runs[0]) || null;
                                    if (r) {
                                        oEntry.runStatus = r.status || "";
                                        oEntry.runAt = r.endTime || r.startTime;
                                    }
                                })
                                .catch(function () {});
                        });

                    // Entries without remoteId → time-proximity fallback
                    var aOrphan = aPast.filter(function (e) { return !e._remoteId && !e.runStatus; });
                    var pFallback = Promise.resolve();
                    if (aOrphan.length && sSpace && sChain) {
                        pFallback = fetch(that._getApiBase() + "dsp/taskchain-runs?spaceId=" + encodeURIComponent(sSpace)
                            + "&taskchain=" + encodeURIComponent(sChain) + "&limit=200",
                            { headers: { "Accept": "application/json" } })
                            .then(function (res) { return res.json(); })
                            .then(function (data) {
                                var aDspRuns = (data && data.success && data.runs) || [];
                                if (!aDspRuns.length) return;
                                var WINDOW_MS = 90 * 60 * 1000;
                                aOrphan.forEach(function (oEntry) {
                                    var sT = oEntry.rawTime || "00:00";
                                    var nEntry = new Date(oEntry.date + "T" + (sT.length === 5 ? sT + ":00" : sT)).getTime();
                                    var oBest = null, nBestDiff = Infinity;
                                    aDspRuns.forEach(function (r) {
                                        if (!r.startTime) return;
                                        var diff = Math.abs(new Date(r.startTime).getTime() - nEntry);
                                        if (diff < WINDOW_MS && diff < nBestDiff) { nBestDiff = diff; oBest = r; }
                                    });
                                    if (oBest) { oEntry.runStatus = oBest.status || ""; oEntry.runAt = oBest.endTime || oBest.startTime; }
                                });
                            })
                            .catch(function () {});
                    }

                    Promise.all(aRemotePromises.concat([pFallback])).then(function () {
                        that._editModel.setProperty("/calendarEntries", aEntries);
                        that._applyPastFilter();
                    });
                }
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

            // Two filters on the SAME path ("date") are OR-combined by UI5 by default
            // (it treats them as a multi-value "IN" style filter) — "date >= from OR
            // date <= to" is true for virtually every date, which is why the range only
            // "worked" when just one bound was set. Combine them explicitly with AND.
            var aDateFilters = [];
            var oFrom = this._editModel.getProperty("/filterDateFrom");
            if (oFrom) {
                aDateFilters.push(new Filter("date", FilterOperator.GE, this._toIsoDate(oFrom)));
            }
            var oTo = this._editModel.getProperty("/filterDateTo");
            if (oTo) {
                aDateFilters.push(new Filter("date", FilterOperator.LE, this._toIsoDate(oTo)));
            }
            if (aDateFilters.length) {
                aFilters.push(new Filter({ filters: aDateFilters, and: true }));
            }

            oBinding.filter(aFilters);
            this._editModel.setProperty("/visibleEntriesCount", this._getVisibleCalendarEntries().length);
        },

        // Same criteria as _applyPastFilter's table filter (Show past entries toggle +
        // From/To date range), but returns the actual plain-JS entry objects so callers
        // like "Delete All" can act only on what the user currently sees.
        _getVisibleCalendarEntries: function () {
            var aEntries = this._editModel.getProperty("/calendarEntries") || [];
            var bShowPast = this._editModel.getProperty("/showPastEntries");
            var oFrom = this._editModel.getProperty("/filterDateFrom");
            var oTo = this._editModel.getProperty("/filterDateTo");
            var sFrom = oFrom ? this._toIsoDate(oFrom) : null;
            var sTo = oTo ? this._toIsoDate(oTo) : null;
            return aEntries.filter(function (e) {
                if (!bShowPast && e.isPast) return false;
                if (sFrom && e.date < sFrom) return false;
                if (sTo && e.date > sTo) return false;
                return true;
            });
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
                    details: e.details || "",
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
            this._editingUnsavedEntry = null;
            var now = new Date();
            this._editModel.setProperty("/entryDate", now.toISOString().slice(0, 10));
            this._editModel.setProperty("/entryTime", "04:00");
            this._editModel.setProperty("/entryActive", true);
            this._editModel.setProperty("/entryParameters", "");
            this._editModel.setProperty("/entryDetails", "");
            this._openCalendarEntryDialog();
        },

        onEditCalendarEntry: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            var o = oCtx.getObject();
            this._editingEntryId = o.ID || null;
            // Staged (not-yet-saved) entries have no ID — keep a direct reference
            // to the exact object so onSaveCalendarEntry can update it in place
            // instead of (falling through to) appending a duplicate new row.
            this._editingUnsavedEntry = o.ID ? null : o;
            this._editModel.setProperty("/entryDate", o.date);
            this._editModel.setProperty("/entryTime", o.rawTime || (o.time || "").replace(/\s*CET.*$/i, ""));
            this._editModel.setProperty("/entryActive", !!o.active);
            this._editModel.setProperty("/entryParameters", o.parameters || "");
            this._editModel.setProperty("/entryDetails", o.details || "");
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
            var sEntryTime = d.entryTime.length === 5 ? d.entryTime + ":00" : d.entryTime;
            var dtEntry = new Date(d.entryDate + "T" + sEntryTime);
            if (dtEntry < new Date()) {
                this.error("Date and time must be in the future");
                return;
            }
            if (d.entryParameters && String(d.entryParameters).trim()) {
                try { JSON.parse(d.entryParameters); }
                catch (e) { this.error("Parameters must be valid JSON: " + e.message); return; }
            }
            var that = this;

            // Editing an existing (already-saved, already-scheduled) entry still
            // applies immediately — there's no "unsaved" concept for it, and the
            // user expects the live schedule to reflect the change right away.
            if (this._editingEntryId) {
                var oModel = this.getModel();
                var oCtxBind = oModel.bindContext("/ScheduleEntry('" + this._editingEntryId + "')");
                oCtxBind.requestObject().then(function () {
                    var oCtx = oCtxBind.getBoundContext();
                    oCtx.setProperty("runDate", d.entryDate);
                    oCtx.setProperty("runTime", d.entryTime);
                    oCtx.setProperty("active", !!d.entryActive);
                    oCtx.setProperty("parameters", d.entryParameters || "");
                    oCtx.setProperty("details", d.entryDetails || "");
                    return oModel.submitBatch(oModel.getUpdateGroupId());
                }).then(function () {
                    // Patch this entry locally instead of a full reload — a full
                    // reload here would wipe any not-yet-saved staged entries from
                    // an upload that hasn't been confirmed with "Save Calendar" yet.
                    var aEntries = (that._editModel.getProperty("/calendarEntries") || []).slice();
                    var iIdx = aEntries.findIndex(function (e) { return e.ID === that._editingEntryId; });
                    if (iIdx !== -1) {
                        var oOld = aEntries[iIdx];
                        var dt = new Date(d.entryDate + "T" + (d.entryTime.length === 5 ? d.entryTime + ":00" : d.entryTime));
                        aEntries[iIdx] = Object.assign({}, oOld, {
                            date: d.entryDate,
                            dateLabel: that._formatDateLabel(d.entryDate),
                            time: d.entryTime + " CET",
                            rawTime: d.entryTime,
                            active: !!d.entryActive,
                            parameters: d.entryParameters || "",
                            details: d.entryDetails || "",
                            isPast: !isNaN(dt.getTime()) && dt < new Date()
                        });
                        that._editModel.setProperty("/calendarEntries", aEntries);
                    }
                    that._updateSummary();
                    that._applyPastFilter();
                    that.onCloseCalendarEntryDialog();
                }).catch(function (err) {
                    that.error(err.message || String(err));
                });
                return;
            }

            // Editing a staged (not-yet-saved) entry — update it in place rather
            // than falling through to "new entry", which would duplicate it.
            if (this._editingUnsavedEntry) {
                var oTarget = this._editingUnsavedEntry;
                this._editingUnsavedEntry = null;
                var dtEdited = new Date(d.entryDate + "T" + (d.entryTime.length === 5 ? d.entryTime + ":00" : d.entryTime));
                var aEntries2 = (this._editModel.getProperty("/calendarEntries") || []).map(function (e) {
                    if (e !== oTarget) return e;
                    return Object.assign({}, e, {
                        date: d.entryDate,
                        dateLabel: that._formatDateLabel(d.entryDate),
                        time: d.entryTime + " CET",
                        rawTime: d.entryTime,
                        active: !!d.entryActive,
                        parameters: d.entryParameters || "",
                        details: d.entryDetails || "",
                        isPast: !isNaN(dtEdited.getTime()) && dtEdited < new Date()
                    });
                });
                this._editModel.setProperty("/calendarEntries", aEntries2);
                this._updateSummary();
                this._applyPastFilter();
                this.onCloseCalendarEntryDialog();
                return;
            }

            // New entry — stage it locally; it's only persisted (and scheduled)
            // once the user clicks "Save Calendar".
            var oNewEntry = {
                ID: null,
                chain: d.taskchain || "",
                date: d.entryDate,
                dateLabel: this._formatDateLabel(d.entryDate),
                time: d.entryTime + " CET",
                rawTime: d.entryTime,
                timezone: "Europe/Rome",
                active: !!d.entryActive,
                parameters: d.entryParameters || "",
                details: d.entryDetails || "",
                isPast: false,
                runStatus: "",
                runAt: null,
                _remoteId: "",
                _unsaved: true
            };
            var aEntries = (this._editModel.getProperty("/calendarEntries") || []).concat([oNewEntry]);
            this._editModel.setProperty("/calendarEntries", aEntries);
            this._updateSummary();
            this._applyPastFilter();
            this.onCloseCalendarEntryDialog();
        },

        onDeleteAllEntries: function () {
            // Only act on entries the user currently sees — respects the "Show past
            // entries" toggle and the From/To date range, same as the table itself.
            var aVisible = this._getVisibleCalendarEntries();
            if (!aVisible.length) return;
            var that = this;
            var oRb = this.getResourceBundle();
            MessageBox.confirm(oRb.getText("calendar.confirmDeleteAll", [aVisible.length]), {
                onClose: function (sAction) {
                    if (sAction !== MessageBox.Action.OK) return;
                    // Unsaved (staged) entries have no ID and nothing to delete server-side —
                    // just drop them locally. Already-saved entries need the real delete flow.
                    var aSaved = aVisible.filter(function (e) { return !e._unsaved; });
                    var aIds = aSaved.map(function (e) { return e.ID; }).filter(Boolean);
                    var oIdSet = {};
                    aIds.forEach(function (sId) { oIdSet[sId] = true; });
                    // Clear only the visible entries from the UI immediately; entries
                    // hidden by the current filter are left untouched.
                    var aRemaining = (that._editModel.getProperty("/calendarEntries") || [])
                        .filter(function (e) {
                            if (e._unsaved) { return aVisible.indexOf(e) === -1; }
                            return !oIdSet[e.ID];
                        });
                    that._editModel.setProperty("/calendarEntries", aRemaining);
                    that._updateSummary();
                    that._applyPastFilter();
                    if (aSaved.length) {
                        // Delete from server + cancel APScheduler jobs in background
                        that._cancelSchedulerJobs(aSaved).catch(function () {});
                        that._deleteEntriesByIds(aIds).catch(function (err) {
                            console.warn("[Scheduler] delete all failed:", err && err.message);
                        });
                    }
                }
            });
        },

        _deleteEntriesByIds: function (aIds) {
            if (!aIds || !aIds.length) return Promise.resolve();
            var oModel = this.getModel();
            var aPromises = aIds.map(function (sId) {
                var oList = oModel.bindList("/ScheduleEntry", undefined, undefined, [
                    new Filter("ID", FilterOperator.EQ, sId)
                ]);
                return oList.requestContexts(0, 1).then(function (aCtx) {
                    if (aCtx.length) return aCtx[0].delete();
                });
            });
            return Promise.all(aPromises);
        },

        _cancelSchedulerJobs: function (aEntries) {
            var that = this;
            var d = this._editModel.getData();
            var sSpace = d.spaceId;
            var sChain = d.taskchain;
            if (!sSpace || !sChain) return Promise.resolve();
            var aFuture = (aEntries || []).filter(function (e) { return !e.isPast; });
            return Promise.all(aFuture.map(function (e) {
                var sRunAt = e.date + "T" + (e.rawTime || "00:00") + ":00";
                return fetch(that._getApiBase() + "scheduler/schedule-once", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ spaceId: sSpace, taskchain: sChain, runAt: sRunAt })
                }).catch(function () {});
            }));
        },

        onRemoveCalendarEntry: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            var o = oCtx.getObject();
            var that = this;

            // Unsaved (staged) entry — never persisted, so just drop it locally.
            if (o._unsaved) {
                var aRemaining = (this._editModel.getProperty("/calendarEntries") || [])
                    .filter(function (e) { return e !== o; });
                this._editModel.setProperty("/calendarEntries", aRemaining);
                this._updateSummary();
                this._applyPastFilter();
                return;
            }

            var oRb = this.getResourceBundle();
            MessageBox.confirm(oRb.getText("calendar.confirmRemove", [o.dateLabel, o.time]), {
                onClose: function (sAction) {
                    if (sAction !== MessageBox.Action.OK) return;
                    var oModel = that.getModel();
                    var oList = oModel.bindList("/ScheduleEntry", undefined, undefined, [
                        new Filter("ID", FilterOperator.EQ, o.ID)
                    ]);
                    that._cancelSchedulerJobs([o]).catch(function () {});
                    oList.requestContexts(0, 1).then(function (aCtx) {
                        if (!aCtx.length) return;
                        return aCtx[0].delete();
                    }).then(function () {
                        // Remove only this entry locally — a full reload here would
                        // wipe any not-yet-saved staged entries from an upload that
                        // hasn't been confirmed with "Save Calendar" yet.
                        var aRemaining = (that._editModel.getProperty("/calendarEntries") || [])
                            .filter(function (e) { return e !== o; });
                        that._editModel.setProperty("/calendarEntries", aRemaining);
                        that._updateSummary();
                        that._applyPastFilter();
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
            var bPast = !!oCtx.getProperty("isPast");
            this._calendarRowCtx = bPast ? null : oCtx;
            this._calendarRowEntryId = bPast ? null : (oCtx.getProperty("ID") || null);
            var sParams = oCtx.getProperty("parameters") || "";
            this._editModel.setProperty("/parameters", sParams);
            var oComp = this.getOwnerComponent();
            if (oComp) {
                oComp._stepParamsState = sParams
                    ? { taskchain: this._editModel.getProperty("/taskchain") || "", parametersJson: sParams, viewOnly: bPast }
                    : null;
                // Snapshot the full local state (including not-yet-saved staged entries)
                // so _onMatched can restore it on return instead of reloading from the
                // server, which would silently drop anything not yet persisted.
                oComp._customCalendarState = Object.assign({}, this._editModel.getData(), {
                    busy: false, calendarUploadBusy: false
                });
            }
            this.onConfigureStepParameters(bPast);
        },

        onConfigureStepParameters: function (bViewOnly) {
            var d = this._editModel.getData();
            var oQuery = {
                spaceId: d.spaceId || "",
                taskchain: d.taskchain || "",
                name: d.name || d.taskchain || "",
                returnTo: "customCalendar"
            };
            if (bViewOnly) oQuery.viewOnly = "1";
            this.getRouter().navTo("stepParameters", { "?query": oQuery });
        },

        _consumeStepParametersResult: function () {
            var oComp = this.getOwnerComponent();
            var s = oComp && oComp._stepParamsState;
            if (!s || s.taskchain !== this._editModel.getProperty("/taskchain") || !s.parametersJson) {
                return Promise.resolve();
            }
            // Past entries are view-only: discard without saving
            if (s.viewOnly) {
                oComp._stepParamsState = null;
                return Promise.resolve();
            }
            // Single-shot consume
            oComp._stepParamsState = null;
            var sEntryId = this._calendarRowEntryId || null;
            var oRowCtx = this._calendarRowCtx || null;
            this._calendarRowEntryId = null;
            this._calendarRowCtx = null;
            if (!sEntryId) {
                // Unsaved (staged) row — write the params directly into its local entry
                // object; they'll be included when the row is actually persisted on Save.
                if (oRowCtx) {
                    this._editModel.setProperty(oRowCtx.getPath() + "/parameters", s.parametersJson);
                } else {
                    this._editModel.setProperty("/parameters", s.parametersJson);
                }
                return Promise.resolve();
            }
            // Reflect the change locally right away — the page no longer reloads from
            // the server on return, so the local copy must be kept in sync itself.
            if (oRowCtx) {
                this._editModel.setProperty(oRowCtx.getPath() + "/parameters", s.parametersJson);
            }
            var oModel = this.getModel();
            var oCtxBind = oModel.bindContext("/ScheduleEntry('" + sEntryId + "')");
            return oCtxBind.requestObject().then(function () {
                oCtxBind.getBoundContext().setProperty("parameters", s.parametersJson);
                return oModel.submitBatch(oModel.getUpdateGroupId());
            }).catch(function (err) {
                console.warn("Could not persist step parameters:", err && err.message);
            });
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
            if (this._calendarRowCtx) {
                var oRow = this._calendarRowCtx.getObject();
                this._editModel.setProperty(this._calendarRowCtx.getPath() + "/parameters", s || "");
                if (oRow && oRow.ID) {
                    var oModel = this.getModel();
                    var oCtxBind = oModel.bindContext("/ScheduleEntry('" + oRow.ID + "')");
                    oCtxBind.requestObject().then(function () {
                        oCtxBind.getBoundContext().setProperty("parameters", s || "");
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
            var that = this;
            var aEntries = this._editModel.getProperty("/calendarEntries") || [];
            var aUnsaved = aEntries.filter(function (e) { return e._unsaved; });
            var aPendingDeleteIds = this._editModel.getProperty("/pendingDeleteIds") || [];

            if (!aUnsaved.length && !aPendingDeleteIds.length) {
                this.error("Nothing to save");
                return;
            }

            this._editModel.setProperty("/busy", true);
            var pDelete = aPendingDeleteIds.length
                ? this._deleteEntriesByIds(aPendingDeleteIds).catch(function () {})
                : Promise.resolve();

            pDelete
                .then(function () { return that._persistCalendarEntries(aUnsaved); })
                .then(function () {
                    that._editModel.setProperty("/pendingDeleteIds", []);
                    return that._loadCalendarEntries();
                })
                .then(function () {
                    that._editModel.setProperty("/busy", false);
                    that.toast(aUnsaved.length + " calendar entries saved and scheduled");
                })
                .catch(function (err) {
                    that._editModel.setProperty("/busy", false);
                    that.error(err.message || String(err));
                });
        }
    });
});
