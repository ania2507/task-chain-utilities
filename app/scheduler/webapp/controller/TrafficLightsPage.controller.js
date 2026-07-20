sap.ui.define([
    "scheduler/controller/BaseController",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator"
], function (BaseController, JSONModel, MessageBox, MessageToast, Filter, FilterOperator) {
    "use strict";

    var DEFAULTS = {
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
        scheduleKind: "TRAFFIC_LIGHTS",
        currentState: "GREEN",
        tlStatus: "",
        checkInterval: "15",
        autoReset: true,
        autoResetState: "GREEN",
        timeout: "48",
        busy: false,
        lastRunAt: null,
        lastRunStatus: "",
        nextCheckIn: null,
        createdBy: "",
        createdAt: null,
        modifiedAt: null,
        returnTo: "scheduleList",
        returnQuery: {}
    };

    return BaseController.extend("scheduler.controller.TrafficLightsPage", {

        onInit: function () {
            this._editModel = new JSONModel(Object.assign({}, DEFAULTS));
            this._previewModel = new JSONModel({ next: [], busy: false });
            this.getView().setModel(this._editModel, "edit");
            this.getView().setModel(this._previewModel, "preview");

            this.getRouter().getRoute("trafficLights").attachPatternMatched(this._onMatched, this);
        },

        _onMatched: function (oEvent) {
            var oArgs = oEvent.getParameter("arguments") || {};
            var oQuery = oArgs["?query"] || {};

            var oComp = this.getOwnerComponent();
            var savedState = oComp && oComp._trafficLightsState;
            if (savedState && savedState.taskchain === (oQuery.taskchain || "")) {
                oComp._trafficLightsState = null;
                this._editModel.setData(savedState);
                // Defensive: the schedule ID drives the Delete button's visibility;
                // restore it from the query if it didn't survive the round trip.
                if (!this._editModel.getProperty("/ID") && oQuery.scheduleID) {
                    this._editModel.setProperty("/ID", oQuery.scheduleID);
                }
                this._previewModel.setProperty("/next", []);
                this._consumeStepParametersResult();
                this._loadTrafficLightStatus(savedState.spaceId, savedState.taskchain);
                this._loadLastRun(savedState.spaceId, savedState.taskchain);
                return;
            }

            this._editModel.setData(Object.assign({}, DEFAULTS, {
                name: oQuery.name || oQuery.taskchain || "",
                spaceId: oQuery.spaceId || "",
                taskchain: oQuery.taskchain || "",
                stepParamsSummary: "",
                returnTo: oQuery.returnTo || "scheduleList",
                returnQuery: {}
            }));
            this._previewModel.setProperty("/next", []);
            this._consumeStepParametersResult();
            this._loadTrafficLightStatus(oQuery.spaceId, oQuery.taskchain);
            this._loadLastRun(oQuery.spaceId, oQuery.taskchain);
            if (oQuery.scheduleID) {
                this._loadSchedule(oQuery.scheduleID);
            }
        },

        _loadSchedule: function (sId) {
            var oModel = this.getModel();
            if (!oModel) return;
            var oBind = oModel.bindContext("/Schedule('" + sId + "')");
            oBind.requestObject().then(function (obj) {
                if (!obj) return;
                var tl = {};
                var stepParamsJson = "";
                if (obj.parameters) {
                    try {
                        tl = JSON.parse(obj.parameters);
                        // Step params are stored nested under __stepParams to avoid
                        // conflict with traffic-light settings.
                        if (tl.__stepParams) {
                            stepParamsJson = JSON.stringify(tl.__stepParams);
                        }
                    } catch (_) {}
                }
                this._editModel.setData(Object.assign({}, DEFAULTS, obj, tl, {
                    parameters: stepParamsJson
                }));
                // Rebuild _stepParamsState from saved parameters so that
                // re-opening StepParametersPage shows the previously saved params.
                this._restoreStepParamsFromEntry(obj.taskchain, stepParamsJson);
                this._loadTrafficLightStatus(obj.spaceId, obj.taskchain);
                this._loadLastRun(obj.spaceId, obj.taskchain);
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

        // Lifecycle / Current state is unified: it comes from
        // TrafficLightStatus.initialState (GREEN = Enabled | RED = Disabled,
        // default GREEN), except while a run is in progress (status =
        // 'running'), in which case it shows as "Running" (GREY) regardless
        // of initialState.
        _loadTrafficLightStatus: function (spaceId, taskchain) {
            var oModel = this.getModel();
            this._tlContext = null;
            this._tlSpaceId = spaceId;
            this._tlTaskchain = taskchain;
            if (!oModel || !spaceId || !taskchain) {
                this._editModel.setProperty("/currentState", "GREEN");
                this._editModel.setProperty("/tlStatus", "");
                return;
            }
            var oList = oModel.bindList("/TrafficLightStatus", undefined, undefined, [
                new Filter("spaceId", FilterOperator.EQ, spaceId),
                new Filter("taskchain", FilterOperator.EQ, taskchain)
            ]);
            oList.requestContexts(0, 1).then(function (aContexts) {
                var status = "";
                var initialState = "GREEN";
                if (aContexts.length) {
                    this._tlContext = aContexts[0];
                    var obj = aContexts[0].getObject();
                    status = (obj.status || "").toLowerCase();
                    initialState = obj.initialState || "GREEN";
                }
                this._editModel.setProperty("/tlStatus", status);
                this._editModel.setProperty("/currentState", status === "running" ? "GREY" : initialState);
            }.bind(this)).catch(function () {
                this._editModel.setProperty("/currentState", "GREEN");
                this._editModel.setProperty("/tlStatus", "");
            }.bind(this));
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
                    // If DSP reports the task chain is currently running, override
                    // currentState immediately without waiting for the monitoring cycle.
                    if (run && (run.status || "").toLowerCase() === "running") {
                        this._editModel.setProperty("/currentState", "GREY");
                        this._editModel.setProperty("/tlStatus", "running");
                    }
                }.bind(this))
                .catch(function () {
                    this._editModel.setProperty("/lastRunAt", null);
                    this._editModel.setProperty("/lastRunStatus", "");
                }.bind(this));
        },

        onSelectStateRed: function () {
            this._setLifecycleState("RED");
        },

        onSelectStateGreen: function () {
            this._setLifecycleState("GREEN");
        },

        // Persist the Lifecycle / Current state (Enabled/Disabled) into
        // TrafficLightStatus.initialState. Has no effect while the task
        // chain is currently running (status = 'running'), since the
        // displayed state stays "Running" regardless.
        _setLifecycleState: function (sState) {
            if (this._editModel.getProperty("/tlStatus") === "running") {
                return;
            }
            this._editModel.setProperty("/currentState", sState);

            var oModel = this.getModel();
            if (!oModel || !this._tlSpaceId || !this._tlTaskchain) return;

            if (this._tlContext) {
                this._tlContext.setProperty("initialState", sState);
                oModel.submitBatch(oModel.getUpdateGroupId()).catch(function (err) {
                    this.error(err && err.message || String(err));
                }.bind(this));
            } else {
                var oList = oModel.bindList("/TrafficLightStatus");
                var oCtx = oList.create({
                    spaceId: this._tlSpaceId,
                    taskchain: this._tlTaskchain,
                    initialState: sState
                });
                oCtx.created().then(function () {
                    this._tlContext = oCtx;
                }.bind(this)).catch(function (err) {
                    this.error(err && err.message || String(err));
                }.bind(this));
            }
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
            var sReturnTo = this._editModel.getProperty("/returnTo") || "scheduleList";
            var oReturnQuery = this._editModel.getProperty("/returnQuery") || {};
            this.getRouter().navTo(sReturnTo, { "?query": oReturnQuery }, true);
        },

        onConfigureStepParameters: function () {
            var d = this._editModel.getData();
            var oComp = this.getOwnerComponent();
            if (oComp) {
                oComp._trafficLightsState = Object.assign({}, d, { busy: false });
            }
            this.getRouter().navTo("stepParameters", {
                "?query": {
                    spaceId: d.spaceId || "",
                    taskchain: d.taskchain || "",
                    name: d.name || "",
                    scheduleID: d.ID || "",
                    returnTo: "trafficLights"
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
            var s = this._editModel.getProperty("/parameters");
            if (s && String(s).trim()) {
                try { JSON.parse(s); }
                catch (e) { this.error("Step parameters must be valid JSON: " + e.message); return; }
            }
            this.onCloseStepParameters();
            MessageToast.show(this.i18n("steps.saved") || "Parameters saved");
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

        onNavigateToSteps: function () {
            this.onConfigureStepParameters();
        },

        onNavigateToLogs: function () {
            MessageToast.show("Execution logs not yet available.");
        },

        onDelete: function () {
            var d = this._editModel.getData();
            if (!d.ID) return;
            var that = this;
            MessageBox.confirm("Delete this traffic lights schedule?", {
                onClose: function (sAction) {
                    if (sAction !== MessageBox.Action.OK) return;
                    var oModel = that.getModel();
                    if (!oModel) return;
                    var oBind = oModel.bindContext("/Schedule('" + d.ID + "')");
                    oBind.requestObject().then(function () {
                        return oBind.getBoundContext().delete();
                    }).then(function () {
                        that.onNavBack();
                    }).catch(function (err) {
                        that.error(err && err.message || String(err));
                    });
                }
            });
        },

        onSave: function () {
            var d = this._editModel.getData();
            if (!d.name || !d.cronExpression || !d.targetType) {
                this.error("Name, target type and cron are required");
                return;
            }
            var oModel = this.getModel();

            var oStepParams = {};
            try { oStepParams = JSON.parse(d.parameters || "{}"); } catch (_) {}
            var tlSettings = {
                scheduleKind: "TRAFFIC_LIGHTS",
                checkInterval: d.checkInterval || "15",
                autoReset: !!d.autoReset,
                autoResetState: d.autoResetState || "GREEN",
                timeout: d.timeout || "48",
                __stepParams: oStepParams
            };
            var payload = {
                name: d.name, description: d.description,
                targetType: d.targetType, spaceId: d.spaceId, taskchain: d.taskchain,
                jobTemplate: d.jobTemplate,
                parameters: JSON.stringify(tlSettings),
                cronExpression: d.cronExpression, timezone: d.timezone,
                isActive: !!d.isActive
            };

            this._editModel.setProperty("/busy", true);
            var that = this;
            var pSaved;
            if (d.ID) {
                // UPDATE existing schedule
                var oCtxBind = oModel.bindContext("/Schedule('" + d.ID + "')");
                pSaved = oCtxBind.requestObject().then(function () {
                    var oCtx = oCtxBind.getBoundContext();
                    Object.keys(payload).forEach(function (k) { oCtx.setProperty(k, payload[k]); });
                    return oModel.submitBatch(oModel.getUpdateGroupId());
                });
            } else {
                var oList = oModel.bindList("/Schedule");
                var oCtxNew = oList.create(payload);
                pSaved = oCtxNew.created();
            }
            pSaved.then(function () {
                that._editModel.setProperty("/busy", false);
                that.toast(that.i18n(d.ID ? "msg.updated" : "msg.created", [d.name]));
                that.onNavBack();
            }).catch(function (err) {
                that._editModel.setProperty("/busy", false);
                that.error(err.message || String(err));
            });
        }
    });
});
