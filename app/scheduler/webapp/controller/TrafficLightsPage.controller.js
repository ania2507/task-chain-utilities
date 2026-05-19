sap.ui.define([
    "scheduler/controller/BaseController",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/ui/core/Fragment",
    "sap/ui/core/routing/History"
], function (BaseController, JSONModel, MessageToast, Fragment, History) {
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
            var oView = this.getView();
            if (!this._pStepDialog) {
                this._pStepDialog = Fragment.load({
                    id: oView.getId(),
                    name: "scheduler.view.fragments.StepParametersDialog",
                    controller: this
                }).then(function (oDialog) {
                    oView.addDependent(oDialog);
                    oDialog.setModel(this._editModel, "edit");
                    return oDialog;
                }.bind(this));
            }
            this._pStepDialog.then(function (oDialog) { oDialog.open(); });
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

            this._editModel.setProperty("/busy", true);
            var that = this;
            var oCtxNew = oList.create(payload);
            oCtxNew.created().then(function () {
                that._editModel.setProperty("/busy", false);
                that.toast(that.i18n("msg.created", [d.name]));
                that.onNavBack();
            }).catch(function (err) {
                that._editModel.setProperty("/busy", false);
                that.error(err.message || String(err));
            });
        }
    });
});
