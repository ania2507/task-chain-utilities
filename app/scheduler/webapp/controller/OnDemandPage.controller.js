sap.ui.define([
    "scheduler/controller/BaseController",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/core/routing/History"
], function (BaseController, JSONModel, MessageBox, MessageToast, History) {
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
                entryId: oQuery.entryId || null,
                onDemandModeIndex: 0,
                onDemandDate: now.toISOString().slice(0, 10),
                onDemandTime: ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2),
                parameters: "",
                busy: false
            });
            this._consumeStepParametersResult();
            if (oQuery.entryId) {
                this._loadEntry(oQuery.entryId);
            }
        },

        _loadEntry: function (sId) {
            var oModel = this.getModel();
            if (!oModel) return;
            var oBind = oModel.bindContext("/CalendarEntry('" + sId + "')");
            oBind.requestObject().then(function (obj) {
                if (!obj) return;
                this._editModel.setProperty("/entryId", obj.ID);
                this._editModel.setProperty("/onDemandModeIndex", 1);
                this._editModel.setProperty("/onDemandDate", obj.runDate || "");
                this._editModel.setProperty("/onDemandTime", obj.runTime || "");
                this._editModel.setProperty("/parameters", obj.parameters || "");
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

        onDeleteOnDemand: function () {
            var d = this._editModel.getData();
            if (!d.entryId) return;
            var that = this;
            MessageBox.confirm("Delete this scheduled run?", {
                onClose: function (sAction) {
                    if (sAction !== MessageBox.Action.OK) return;
                    var oModel = that.getModel();
                    if (!oModel) return;
                    var oBind = oModel.bindContext("/CalendarEntry('" + d.entryId + "')");
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

        onConfigureStepParameters: function () {
            var d = this._editModel.getData();
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
                        var oCtxBind = oModel.bindContext("/CalendarEntry('" + d.entryId + "')");
                        pPersist = oCtxBind.requestObject().then(function () {
                            var oCtx = oCtxBind.getBoundContext();
                            oCtx.setProperty("runDate", d.onDemandDate);
                            oCtx.setProperty("runTime", d.onDemandTime);
                            oCtx.setProperty("parameters", d.parameters && String(d.parameters).trim() ? d.parameters : "");
                            oCtx.setProperty("active", true);
                            return oModel.submitBatch(oModel.getUpdateGroupId());
                        });
                    } else {
                        var oList = oModel.bindList("/CalendarEntry");
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
                    return that.callScheduler("/schedule-once", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload)
                    });
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
