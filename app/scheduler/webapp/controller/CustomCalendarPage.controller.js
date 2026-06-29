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
            var that = this;
            var sChain = this._editModel.getProperty("/taskchain") || "TASK_CHAIN_NAME";
            var sSpaceId = this._editModel.getProperty("/spaceId") || "";
            var aCalRows = [
                ["ID", "Chain", "Date", "Time"],
                [1, sChain, "2026-09-19", "04:00"],
                [2, sChain, "2026-09-26", "04:00"],
                [3, sChain, "2026-10-10", "04:00"]
            ];

            if (typeof window.XLSX === "undefined") {
                var sCsv = aCalRows.map(function (r) { return r.join(","); }).join("\n");
                this._downloadBlob(new Blob([sCsv], { type: "text/csv" }), "calendar_template.csv");
                return;
            }

            // No step context → simple single-sheet download
            if (!sSpaceId || !sChain || sChain === "TASK_CHAIN_NAME") {
                this._writeCalendarXlsx(aCalRows, [], []);
                return;
            }

            this._editModel.setProperty("/busy", true);
            fetch("v1/dsp/taskchain-steps?spaceId=" + encodeURIComponent(sSpaceId)
                + "&taskchain=" + encodeURIComponent(sChain), {
                headers: { "Accept": "application/json" }
            })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                var aSteps = (data && data.steps) || [];

                // Unique IBP templates (preserve DSP step objectId for upload mapping)
                var aIbpEntries = [];
                var oIbpSeen = {};
                aSteps.forEach(function (s) {
                    if (s.ibpTemplateName && !oIbpSeen[s.ibpTemplateName]) {
                        oIbpSeen[s.ibpTemplateName] = true;
                        aIbpEntries.push({ objectId: s.objectId, template: s.ibpTemplateName });
                    }
                });

                // SAC steps (one sheet per step)
                var aSacSteps = aSteps.filter(function (s) { return !!s.sacMultiActionId; });

                var aIbpPromises = aIbpEntries.map(function (entry) {
                    return fetch("v1/jobs/ibp/template-steps", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Accept": "application/json" },
                        body: JSON.stringify({ template_name: entry.template })
                    })
                    .then(function (r) { return r.json(); })
                    .then(function (d) { return { objectId: entry.objectId, template: entry.template, data: d }; })
                    .catch(function () { return { objectId: entry.objectId, template: entry.template, data: {} }; });
                });

                return Promise.all(aIbpPromises).then(function (aIbpResults) {
                    return { ibpResults: aIbpResults, sacSteps: aSacSteps };
                });
            })
            .then(function (result) {
                that._editModel.setProperty("/busy", false);
                that._writeCalendarXlsx(aCalRows, result.ibpResults, result.sacSteps);
            })
            .catch(function (err) {
                that._editModel.setProperty("/busy", false);
                console.warn("[Scheduler] template fetch failed, falling back to simple template:", err);
                that._writeCalendarXlsx(aCalRows, [], []);
            });
        },

        _writeCalendarXlsx: function (aCalRows, aIbpResults, aSacSteps) {
            var XLSX = window.XLSX;
            var wb = XLSX.utils.book_new();

            // IDs from data rows (skip header row)
            var aCalIds = aCalRows.slice(1).map(function (r) { return r[0]; });

            // Sheet 1: Calendar (ID | Chain | Date | Time)
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aCalRows), "Calendar");

            // Sheet 2: IBP — one row per (scheduleId × dspStep × ibpStep × parameter)
            // Steps without globalVars are skipped entirely.
            var aIbpRows = [["Schedule ID", "DSP Step", "IBP Step", "Parameter", "Value"]];
            var bHasIbpData = false;
            aCalIds.forEach(function (id) {
                aIbpResults.forEach(function (ibpResult) {
                    var aIbpSteps = (ibpResult.data && ibpResult.data.steps) || [];
                    aIbpSteps.forEach(function (s) {
                        var aVars = (s.globalVars || []).filter(function (g) { return !!g.name; });
                        if (!aVars.length) return;
                        bHasIbpData = true;
                        aVars.forEach(function (g) {
                            aIbpRows.push([
                                id,
                                ibpResult.objectId,
                                s.name || ("Step " + s.order),
                                g.name,
                                g.currentValue || ""
                            ]);
                        });
                    });
                });
            });
            if (bHasIbpData) {
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aIbpRows), "IBP");
            }

            // SAC sheet: single flat sheet mirroring the IBP structure.
            // Columns: Schedule ID | DSP Step | Parameter | Value | HierarchyId
            if (aSacSteps.length) {
                var aSacRows = [["Schedule ID", "DSP Step", "Parameter", "Value", "HierarchyId"]];
                aCalIds.forEach(function (id) {
                    aSacSteps.forEach(function (s) {
                        aSacRows.push([id, s.objectId || s.name || "", "", "", ""]);
                    });
                });
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aSacRows), "SAC");
            }

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
                var oParsed;
                try {
                    oParsed = that._parseCalendarBuffer(e.target.result, oFile.name);
                } catch (err) {
                    console.error("[Scheduler] calendar parse error", err);
                    var oRb = that.getResourceBundle();
                    MessageBox.error(oRb.getText("calendar.parseError", [err.message || String(err)]));
                    return;
                }

                var sChain = that._editModel.getProperty("/taskchain");

                // If the file has the new flat SAC sheet, fetch step definitions to inject
                // __sacMultiActionId sentinel for each DSP step referenced in the sheet.
                var pStepMap = Promise.resolve({});
                if (oParsed.sacFlatDspSteps && oParsed.sacFlatDspSteps.length) {
                    var sSpaceId = that._editModel.getProperty("/spaceId") || "";
                    pStepMap = fetch("v1/dsp/taskchain-steps?spaceId=" + encodeURIComponent(sSpaceId)
                        + "&taskchain=" + encodeURIComponent(sChain))
                        .then(function (r) { return r.json(); })
                        .then(function (d) {
                            var oMap = {};
                            ((d && d.steps) || []).forEach(function (s) {
                                if (s.objectId && s.sacMultiActionId) oMap[s.objectId] = s.sacMultiActionId;
                            });
                            return oMap;
                        })
                        .catch(function () { return {}; });
                }

                pStepMap.then(function (oStepMaMap) {
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

                    var aEntries = that._buildCalendarEntries(oParsed.rows, sChain, oParsed.paramsByScheduleId);

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
                        MessageBox.error(
                            "The file contains duplicate date/time combinations:\n" +
                            aFileDups.slice(0, 5).join("\n") +
                            (aFileDups.length > 5 ? "\n…and " + (aFileDups.length - 5) + " more" : "")
                        );
                        return;
                    }

                    // Check 2: collision with entries already on the app (same date+time)
                    var aExisting = that._editModel.getProperty("/calendarEntries") || [];
                    var oAppSeen = {};
                    aExisting.forEach(function (entry) {
                        oAppSeen[entry.date + "T" + (entry.rawTime || "")] = true;
                    });
                    var aCollisions = aEntries.filter(function (entry) {
                        return !!oAppSeen[entry.date + "T" + entry.rawTime];
                    });

                    function doUpload() {
                        that._editModel.setProperty("/calendarFileStatus",
                            oFile.name + " — " + aEntries.length + " entries");
                        var aExistingIds = aExisting.map(function (e) { return e.ID; }).filter(Boolean);
                        that._deleteEntriesByIds(aExistingIds)
                            .catch(function () {})
                            .then(function () { return that._persistCalendarEntries(aEntries); })
                            .then(function () { that._loadCalendarEntries(); });
                    }

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
                            "\n\nProceed and overwrite all existing entries?",
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
            if (/\.csv$/i.test(oFile.name)) {
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
            var ws = wb.Sheets[wb.SheetNames[0]];
            var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: "yyyy-mm-dd" });

            // paramsByScheduleId: { scheduleId: { dspStepId: [{key, value, active, step?}] } }
            var oBySchId = {};

            // IBP sheet columns: Schedule ID | DSP Step | IBP Step | Parameter | Value
            if (wb.SheetNames.indexOf("IBP") !== -1) {
                var wsIbp = wb.Sheets["IBP"];
                var aIbpRows = XLSX.utils.sheet_to_json(wsIbp, { header: 1, raw: false });
                var hIbp = (aIbpRows[0] || []).map(function (s) { return String(s || "").toLowerCase().trim(); });
                var bIbpHasId = hIbp[0] === "schedule id" || hIbp[0] === "id";
                var iSch = bIbpHasId ? 0 : -1;
                var iDsp = bIbpHasId ? 1 : 0;
                var iStp = bIbpHasId ? 2 : 1;
                var iKey = bIbpHasId ? 3 : 2;
                var iVal = bIbpHasId ? 4 : 3;
                for (var ii = 1; ii < aIbpRows.length; ii++) {
                    var ri = aIbpRows[ii] || [];
                    var sSchId   = iSch >= 0 ? String(ri[iSch] || "").trim() : "1";
                    var sDspStep = String(ri[iDsp] || "").trim();
                    var sIbpStep = String(ri[iStp] || "").trim();
                    var sKey     = String(ri[iKey] || "").trim();
                    var sVal     = String(ri[iVal] || "").trim();
                    if (!sDspStep || !sKey || !sVal) continue;
                    if (!oBySchId[sSchId]) oBySchId[sSchId] = {};
                    if (!oBySchId[sSchId][sDspStep]) oBySchId[sSchId][sDspStep] = [];
                    var oParam = { key: sKey, value: sVal, active: true };
                    if (sIbpStep) oParam.step = sIbpStep;
                    oBySchId[sSchId][sDspStep].push(oParam);
                }
            }

            // Legacy SAC_<dspStepId> sheets (backward compat): Schedule ID | Parameter | Value
            wb.SheetNames.forEach(function (sName) {
                if (sName.indexOf("SAC_") !== 0) return;
                var sDspStep = sName.slice(4);
                if (!sDspStep) return;
                var wsSac = wb.Sheets[sName];
                var aSacRows = XLSX.utils.sheet_to_json(wsSac, { header: 1, raw: false });
                var hSac = (aSacRows[0] || []).map(function (s) { return String(s || "").toLowerCase().trim(); });
                var bSacHasId = hSac[0] === "schedule id" || hSac[0] === "id";
                var iSchS = bSacHasId ? 0 : -1;
                var iPId  = bSacHasId ? 1 : 0;
                var iPVal = bSacHasId ? 2 : 1;
                for (var is = 1; is < aSacRows.length; is++) {
                    var rs = aSacRows[is] || [];
                    var sSchId  = iSchS >= 0 ? String(rs[iSchS] || "").trim() : "1";
                    var sParamId  = String(rs[iPId]  || "").trim();
                    var sParamVal = String(rs[iPVal] || "").trim();
                    if (!sParamId) continue;
                    if (!oBySchId[sSchId]) oBySchId[sSchId] = {};
                    if (!oBySchId[sSchId][sDspStep]) oBySchId[sSchId][sDspStep] = [];
                    oBySchId[sSchId][sDspStep].push({ key: sParamId, value: sParamVal, active: true });
                }
            });

            // New flat SAC sheet: Schedule ID | DSP Step | Parameter | Value
            // oDspStepsWithSac: objectId → sacMultiActionId, injected by onCalendarFileSelect after fetch
            var aSacFlatDspSteps = [];
            if (wb.SheetNames.indexOf("SAC") !== -1) {
                var wsSacFlat = wb.Sheets["SAC"];
                var aSacFlatRows = XLSX.utils.sheet_to_json(wsSacFlat, { header: 1, raw: false });
                var hSacFlat = (aSacFlatRows[0] || []).map(function (s) { return String(s || "").toLowerCase().trim(); });
                var bSacFlatHasId = hSacFlat[0] === "schedule id" || hSacFlat[0] === "id";
                var iSF_Sch = bSacFlatHasId ? 0 : -1;
                var iSF_Dsp = bSacFlatHasId ? 1 : 0;
                var iSF_Par = bSacFlatHasId ? 2 : 1;
                var iSF_Val = bSacFlatHasId ? 3 : 2;
                var iSF_Hid = bSacFlatHasId ? 4 : 3;
                for (var sf = 1; sf < aSacFlatRows.length; sf++) {
                    var rsf = aSacFlatRows[sf] || [];
                    var sSF_SchId   = iSF_Sch >= 0 ? String(rsf[iSF_Sch] || "").trim() : "1";
                    var sSF_DspStep = String(rsf[iSF_Dsp] || "").trim();
                    var sSF_ParamId = String(rsf[iSF_Par] || "").trim();
                    var sSF_Val     = String(rsf[iSF_Val] || "").trim();
                    var sSF_HId     = String(rsf[iSF_Hid] || "").trim();
                    if (!sSF_DspStep || !sSF_ParamId) continue;
                    // Store value and hierarchyId as separate fields (same shape as UI model).
                    // _buildSaveOutput in StepParametersPage will serialize them to JSON when saving.
                    if (!oBySchId[sSF_SchId]) oBySchId[sSF_SchId] = {};
                    if (!oBySchId[sSF_SchId][sSF_DspStep]) {
                        oBySchId[sSF_SchId][sSF_DspStep] = [];
                        if (aSacFlatDspSteps.indexOf(sSF_DspStep) === -1) aSacFlatDspSteps.push(sSF_DspStep);
                    }
                    var oParam = { key: sSF_ParamId, value: sSF_Val, active: true };
                    if (sSF_HId) oParam.hierarchyId = sSF_HId;
                    oBySchId[sSF_SchId][sSF_DspStep].push(oParam);
                }
            }

            return { rows: rows, paramsByScheduleId: oBySchId, sacFlatDspSteps: aSacFlatDspSteps };
        },

        _buildCalendarEntries: function (aRows, sChain, oParamsByScheduleId) {
            if (!aRows || !aRows.length) return [];
            var first = aRows[0].map(function (s) { return String(s || "").toLowerCase().trim(); });
            var bHasId = first[0] === "id" || first[0] === "schedule id";
            var iIdCol    = bHasId ? 0 : -1;
            var iChainCol = bHasId ? 1 : 0;
            var iDateCol  = bHasId ? 2 : 1;
            var iTimeCol  = bHasId ? 3 : 2;
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
                var time = String(r[iTimeCol] || "00:00").trim();
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
                    parameters: oEntryParams ? JSON.stringify(oEntryParams) : ""
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
                $select: "ID,spaceId,taskchain,runDate,runTime,timezone,active,parameters,source",
                $expand: "runs($select=status,triggeredAt,finishedAt,errorMessage)"
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

                // Enrich past entries that have no ScheduleRun record with DSP run history
                var aPastNoStatus = aEntries.filter(function (e) { return e.isPast && !e.runStatus; });
                if (aPastNoStatus.length && sSpace && sChain) {
                    var sRunsUrl = "v1/dsp/taskchain-runs?spaceId=" + encodeURIComponent(sSpace)
                        + "&taskchain=" + encodeURIComponent(sChain) + "&limit=200";
                    fetch(sRunsUrl, { headers: { "Accept": "application/json" } })
                        .then(function (res) { return res.json(); })
                        .then(function (data) {
                            var aDspRuns = (data && data.success && data.runs) || [];
                            if (!aDspRuns.length) return;
                            var WINDOW_MS = 90 * 60 * 1000;
                            aPastNoStatus.forEach(function (oEntry) {
                                var sT = oEntry.rawTime || "00:00";
                                var dtEntry = new Date(oEntry.date + "T" + (sT.length === 5 ? sT + ":00" : sT));
                                var nEntry = dtEntry.getTime();
                                var oBest = null, nBestDiff = Infinity;
                                aDspRuns.forEach(function (r) {
                                    if (!r.startTime) return;
                                    var diff = Math.abs(new Date(r.startTime).getTime() - nEntry);
                                    if (diff < WINDOW_MS && diff < nBestDiff) {
                                        nBestDiff = diff; oBest = r;
                                    }
                                });
                                if (oBest) {
                                    oEntry.runStatus = oBest.status || "";
                                    oEntry.runAt = oBest.endTime || oBest.startTime;
                                }
                            });
                            that._editModel.setProperty("/calendarEntries", aEntries);
                            that._applyPastFilter();
                        })
                        .catch(function () { /* best-effort */ });
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
            var pSaved;
            if (this._editingEntryId) {
                var oCtxBind = oModel.bindContext("/ScheduleEntry(" + this._editingEntryId + ")");
                pSaved = oCtxBind.requestObject().then(function () {
                    var oCtx = oCtxBind.getBoundContext();
                    oCtx.setProperty("runDate", d.entryDate);
                    oCtx.setProperty("runTime", d.entryTime);
                    oCtx.setProperty("active", !!d.entryActive);
                    oCtx.setProperty("parameters", d.entryParameters || "");
                    return oModel.submitBatch(oModel.getUpdateGroupId());
                });
            } else {
                var oList = oModel.bindList("/ScheduleEntry");
                var oCtxNew = oList.create({
                    spaceId: d.spaceId || "",
                    taskchain: d.taskchain || "",
                    runDate: d.entryDate,
                    runTime: d.entryTime,
                    timezone: "Europe/Rome",
                    active: !!d.entryActive,
                    parameters: d.entryParameters || ""
                });
                pSaved = oCtxNew.created();
            }
            pSaved.then(function () {
                that.onCloseCalendarEntryDialog();
                that._loadCalendarEntries();
            }).catch(function (err) {
                that.error(err.message || String(err));
            });
        },

        onDeleteAllEntries: function () {
            var aEntries = this._editModel.getProperty("/calendarEntries") || [];
            if (!aEntries.length) return;
            var that = this;
            var oRb = this.getResourceBundle();
            MessageBox.confirm(oRb.getText("calendar.confirmDeleteAll", [aEntries.length]), {
                onClose: function (sAction) {
                    if (sAction !== MessageBox.Action.OK) return;
                    // Clear UI immediately so back button / upload remain usable
                    var aIds = aEntries.map(function (e) { return e.ID; }).filter(Boolean);
                    that._editModel.setProperty("/calendarEntries", []);
                    that._editModel.setProperty("/calendarFileStatus", "");
                    that._updateSummary();
                    // Delete from server in background – errors are silently logged
                    that._deleteEntriesByIds(aIds).catch(function (err) {
                        console.warn("[Scheduler] delete all failed:", err && err.message);
                    });
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
            this._calendarRowEntryId = null;
            this._calendarRowCtx = null;
            if (!sEntryId) {
                this._editModel.setProperty("/parameters", s.parametersJson);
                return Promise.resolve();
            }
            var oModel = this.getModel();
            var oCtxBind = oModel.bindContext("/ScheduleEntry(" + sEntryId + ")");
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
                    var oCtxBind = oModel.bindContext("/ScheduleEntry(" + oRow.ID + ")");
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
