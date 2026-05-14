sap.ui.define([
    "scheduler/controller/BaseController"
], function (BaseController) {
    "use strict";

    return BaseController.extend("scheduler.controller.ScheduleDetail", {

        onInit: function () {
            this.getRouter().getRoute("scheduleDetail")
                .attachPatternMatched(this._onMatched, this);
        },

        _onMatched: function (oEvt) {
            var sId = oEvt.getParameter("arguments").scheduleId;
            this.getView().bindElement({
                path: "/Schedule(" + this._key(sId) + ")",
                parameters: { $expand: "runs" }
            });
        },

        onNavBack: function () { this.getRouter().navTo("scheduleList"); },

        onRefresh: function () {
            var oCtx = this.getView().getBindingContext();
            if (oCtx) oCtx.refresh();
        },

        onRunNow: function () {
            var oCtx = this.getView().getBindingContext();
            if (!oCtx) return;
            var sId = oCtx.getProperty("ID");
            var sName = oCtx.getProperty("name");
            this.callScheduler("/run-now/" + sId, { method: "POST" })
                .then(function () {
                    this.toast(this.i18n("msg.runTriggered", [sName]));
                    setTimeout(this.onRefresh.bind(this), 1500);
                }.bind(this))
                .catch(function (err) { this.error(err.message); }.bind(this));
        },

        onToggleActive: function () {
            var oCtx = this.getView().getBindingContext();
            if (!oCtx) return;
            var bActive = oCtx.getProperty("isActive");
            oCtx.setProperty("isActive", !bActive);
            oCtx.getModel().submitBatch(oCtx.getModel().getUpdateGroupId())
                .then(function () { this.toast("Updated"); }.bind(this))
                .catch(function (err) { this.error(err.message); }.bind(this));
        },

        _key: function (id) { return "'" + id + "'"; }
    });
});
