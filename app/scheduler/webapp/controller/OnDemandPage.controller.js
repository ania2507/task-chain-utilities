sap.ui.define([
    "scheduler/controller/BaseController",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast"
], function (BaseController, JSONModel, MessageBox, MessageToast) {
    "use strict";

    return BaseController.extend("scheduler.controller.OnDemandPage", {

        onInit: function () {
            var oModel = new JSONModel({
                name: "",
                spaceId: "",
                taskchain: "",
                onDemandModeIndex: 0,
                onDemandDate: "",
                onDemandTime: "",
                parameters: "",
                stepParamsSummary: "",
                lastRunAt: null,
                lastRunStatus: "",
                busy: false
            });
            this.getView().setModel(oModel, "edit");
            this._editModel = oModel;

            this.getRouter().getRoute("onDemand").attachPatternMatched(this._onMatched, this);
        },

        _onMatched: function (oEvent) {
            var oArgs = oEvent.getParameter("arguments") || {};
            var oQuery = oArgs["?query"] || {};

            // If returning from step parameters, restore saved state instead of resetting
            var oComp = this.getOwnerComponent();
            var savedState = oComp && oComp._onDemandState;
            if (savedState && savedState.taskchain === (oQuery.taskchain || "")) {
                oComp._onDemandState = null;
                this._editModel.setData(savedState);
                this._consumeStepParametersResult();
                this._loadLastRun(savedState.spaceId, savedState.taskchain);
                return;
            }

            var now = new Date();
            this._editModel.setData({
                name: oQuery.name || oQuery.taskchain || "",
                spaceId: oQuery.spaceId || "",
                taskchain: oQuery.taskchain || "",
                entryId: oQuery.entryId || null,
                onDemandModeIndex: 0,
                onDemandDate: now.toISOString().slice(0, 10),
                onDemandTime: ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2),
                parameters: "",
                stepParamsSummary: "",
                lastRunAt: null,
                lastRunStatus: "",
                busy: false
            });
            this._consumeStepParametersResult();
            this._loadLastRun(oQuery.spaceId, oQuery.taskchain);
            if (oQuery.entryId) {
                this._loadEntry(oQuery.entryId);
            }
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

        _loadEntry: function (sId) {
            var oModel = this.getModel();
            if (!oModel) return;
            var oBind = oModel.bindContext("/ScheduleEntry('" + sId + "')");
            oBind.requestObject().then(function (obj) {
                if (!obj) return;
                this._editModel.setProperty("/entryId", obj.ID);
                this._editModel.setProperty("/onDemandModeIndex", 1);
                this._editModel.setProperty("/onDemandDate", obj.runDate || "");
                this._editModel.setProperty("/onDemandTime", obj.runTime || "");
                this._editModel.setProperty("/parameters", obj.parameters || "");
                // Rebuild _stepParamsState from saved parameters so that
                // re-opening StepParametersPage shows the previously saved params.
                this._restoreStepParamsFromEntry(
                    this._editModel.getProperty("/taskchain"),
                    obj.parameters
                );
                this._consumeStepParametersResult();
            }.bind(this)).catch(function (err) {
                this.error("Could not load schedule: " + (err && err.message || err));
            }.bind(this));
        },

        _restoreStepParamsFromEntry: function (sTaskchain, sParametersJson) {
            if (!sTaskchain || !sParametersJson || !String(sParametersJson).trim()) return;
            var oComp = this.getOwnerComponent();
            if (!oComp) return;
            // Don't overwrite params freshly edited by the user in StepParametersPage
            if (oComp._stepParamsState && oComp._stepParamsState.taskchain === sTaskchain
                    && oComp._stepParamsState._fresh) return;
            try {
                JSON.parse(sParametersJson); // validate JSON before storing
                // Store only parametersJson (no synthetic steps).
                // StepParametersPage will load real DSP steps and apply these params after loading.
                oComp._stepParamsState = {
                    cacheKey: sTaskchain,
                    taskchain: sTaskchain,
                    steps: [],
                    parametersJson: sParametersJson
                };
            } catch (_) {}
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

        onNavBack: function () {
            this.getRouter().navTo("scheduleList", {}, true);
        },

        onDeleteOnDemand: function () {
            var d = this._editModel.getData();
            if (!d.entryId) return;
            var that = this;
            MessageBox.confirm("Delete this scheduled run?", {
                onClose: function (sAction) {
                    if (sAction !== MessageBox.Action.OK) return;
                    var oModel = that.getModel();
                    if (!oModel) return;
                    var oBind = oModel.bindContext("/ScheduleEntry('" + d.entryId + "')");
                    oBind.requestObject().then(function () {
                        return oBind.getBoundContext().delete();
                    }).then(function () {
                        var oComp = that.getOwnerComponent();
                        if (oComp && oComp._stepParamsState && oComp._stepParamsState.taskchain === d.taskchain) {
                            oComp._stepParamsState = null;
                        }
                        that.onNavBack();
                    }).catch(function (err) {
                        that.error(err && err.message || String(err));
                    });
                }
            });
        },

        onConfigureStepParameters: function () {
            var d = this._editModel.getData();
            // Save current state so _onMatched can restore it on return
            var oComp = this.getOwnerComponent();
            if (oComp) {
                oComp._onDemandState = Object.assign({}, d, { busy: false });
            }
            this.getRouter().navTo("stepParameters", {
                "?query": {
                    spaceId: d.spaceId || "",
                    taskchain: d.taskchain || "",
                    name: d.name || "",
                    returnTo: "onDemand"
                }
            });
        },

        _consumeStepParametersResult: function () {
            var oComp = this.getOwnerComponent();
            var s = oComp && oComp._stepParamsState;
            if (s && s.taskchain === this._editModel.getProperty("/taskchain") && s.parametersJson) {
                this._editModel.setProperty("/parameters", s.parametersJson);
                try {
                    var oParams = JSON.parse(s.parametersJson);
                    var iCount = Object.keys(oParams).filter(function (k) { return oParams[k] && oParams[k].length; }).length;
                    this._editModel.setProperty("/stepParamsSummary", iCount > 0 ? iCount + " step(s) with params configured" : "");
                } catch (_) {}
            }
        },

        onCloseStepParameters: function () {
            if (this._pStepDialog) this._pStepDialog.then(function (d) { d.close(); });
        },

        onSaveStepParameters: function () {
            // Validate JSON if provided
            var s = this._editModel.getProperty("/parameters");
            if (s && String(s).trim()) {
                try { JSON.parse(s); }
                catch (e) { this.error("Step parameters must be valid JSON: " + e.message); return; }
            }
            this.onCloseStepParameters();
            MessageToast.show(this.i18n("steps.saved") || "Parameters saved");
        },

        onConfirmOnDemand: function () {
            var d = this._editModel.getData();
            if (!d.spaceId || !d.taskchain) {
                this.error("Missing taskchain context");
                return;
            }

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

            this._editModel.setProperty("/busy", true);
            var that = this;

            if (d.onDemandModeIndex === 0) {
                this.callScheduler("/run-now-adhoc", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                }).then(function () {
                    that._editModel.setProperty("/busy", false);
                    that.toast(that.i18n("msg.runTriggered", [d.name || d.taskchain]));
                    that.onNavBack();
                }).catch(function (err) {
                    that._editModel.setProperty("/busy", false);
                    that.error(err.message || String(err));
                });
            } else {
                if (!d.onDemandDate || !d.onDemandTime) {
                    this._editModel.setProperty("/busy", false);
                    this.error("Please choose date and time");
                    return;
                }
                payload.runAt = d.onDemandDate + "T" + d.onDemandTime + ":00";

                // Persist a CalendarEntry to HDI so the schedule survives restarts
                // and shows up on the first page. If we are editing an existing
                // entry (entryId), update it in place instead of creating a new one.
                var oModel = this.getModel();
                var pPersist = Promise.resolve();
                if (oModel) {
                    if (d.entryId) {
                        var oCtxBind = oModel.bindContext("/ScheduleEntry('" + d.entryId + "')");
                        pPersist = oCtxBind.requestObject().then(function () {
                            var oCtx = oCtxBind.getBoundContext();
                            oCtx.setProperty("runDate", d.onDemandDate);
                            oCtx.setProperty("runTime", d.onDemandTime);
                            oCtx.setProperty("parameters", d.parameters && String(d.parameters).trim() ? d.parameters : "");
                            oCtx.setProperty("active", true);
                            return oModel.submitBatch(oModel.getUpdateGroupId());
                        });
                    } else {
                        var oList = oModel.bindList("/ScheduleEntry");
                        var oCtxNew = oList.create({
                            spaceId: d.spaceId,
                            taskchain: d.taskchain,
                            runDate: d.onDemandDate,
                            runTime: d.onDemandTime,
                            timezone: "Europe/Rome",
                            active: true,
                            parameters: d.parameters && String(d.parameters).trim() ? d.parameters : "",
                            source: "onDemand"
                        });
                        pPersist = oCtxNew.created();
                    }
                }

                pPersist.then(function () {
                    that._editModel.setProperty("/busy", false);
                    that.toast(that.i18n("msg.created", [d.name || d.taskchain]));
                    that.onNavBack();
                    // Fire scheduler registration in background — does not block navigation
                    that.callScheduler("/schedule-once", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload)
                    }).catch(function (err) {
                        console.warn("[OnDemand] scheduler /schedule-once failed:", err.message || err);
                    });
                }).catch(function (err) {
                    that._editModel.setProperty("/busy", false);
                    that.error(err.message || String(err));
                });
            }
        }
    });
});
