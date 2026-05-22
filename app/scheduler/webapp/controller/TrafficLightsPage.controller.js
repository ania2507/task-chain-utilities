sap.ui.define([
    "scheduler/controller/BaseController",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/core/routing/History"
], function (BaseController, JSONModel, MessageBox, MessageToast, History) {
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
        checkInterval: "15",
        autoReset: true,
        autoResetState: "GREY",
        timeout: "48",
        busy: false
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
            this._editModel.setData(Object.assign({}, DEFAULTS, {
                name: oQuery.name || oQuery.taskchain || "",
                spaceId: oQuery.spaceId || "",
                taskchain: oQuery.taskchain || ""
            }));
            this._previewModel.setProperty("/next", []);
            this._consumeStepParametersResult();
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
                if (obj.parameters) {
                    try { tl = JSON.parse(obj.parameters); } catch (_) {}
                }
                this._editModel.setData(Object.assign({}, DEFAULTS, obj, tl));
            }.bind(this)).catch(function (err) {
                this.error("Could not load schedule: " + (err && err.message || err));
            }.bind(this));
        },

        formatBusinessName: function (v) {
            if (!v) return "";
            return String(v).replace(/^\s*task\s*chain\s*[-:–]\s*/i, "");
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

        onConfigureStepParameters: function () {
            var d = this._editModel.getData();
            this.getRouter().navTo("stepParameters", {
                "?query": {
                    spaceId: d.spaceId || "",
                    taskchain: d.taskchain || "",
                    name: d.name || "",
                    returnTo: "trafficLights"
                }
            });
        },

        _consumeStepParametersResult: function () {
            var oComp = this.getOwnerComponent();
            var s = oComp && oComp._stepParamsState;
            if (s && s.taskchain === this._editModel.getProperty("/taskchain") && s.parametersJson) {
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

            var tlSettings = {
                scheduleKind: "TRAFFIC_LIGHTS",
                currentState: d.currentState || "GREEN",
                checkInterval: d.checkInterval || "15",
                autoReset: !!d.autoReset,
                autoResetState: d.autoResetState || "GREY",
                timeout: d.timeout || "48"
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
