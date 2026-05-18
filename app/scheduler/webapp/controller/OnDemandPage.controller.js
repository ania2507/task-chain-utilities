sap.ui.define([
    "scheduler/controller/BaseController",
    "sap/ui/core/Fragment",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/ui/core/routing/History"
], function (BaseController, Fragment, JSONModel, MessageToast, History) {
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
                busy: false
            });
            this.getView().setModel(oModel, "edit");
            this._editModel = oModel;

            this.getRouter().getRoute("onDemand").attachPatternMatched(this._onMatched, this);
        },

        _onMatched: function (oEvent) {
            var oArgs = oEvent.getParameter("arguments") || {};
            var oQuery = oArgs["?query"] || {};
            var now = new Date();
            this._editModel.setData({
                name: oQuery.name || oQuery.taskchain || "",
                spaceId: oQuery.spaceId || "",
                taskchain: oQuery.taskchain || "",
                onDemandModeIndex: 0,
                onDemandDate: now.toISOString().slice(0, 10),
                onDemandTime: ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2),
                parameters: "",
                busy: false
            });
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
                this.callScheduler("/schedule-once", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                }).then(function () {
                    that._editModel.setProperty("/busy", false);
                    that.toast(that.i18n("msg.created", [d.name || d.taskchain]));
                    that.onNavBack();
                }).catch(function (err) {
                    that._editModel.setProperty("/busy", false);
                    that.error(err.message || String(err));
                });
            }
        }
    });
});
