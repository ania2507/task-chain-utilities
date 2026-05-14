sap.ui.define([
    "scheduler/controller/BaseController",
    "sap/ui/model/json/JSONModel"
], function (BaseController, JSONModel) {
    "use strict";

    return BaseController.extend("scheduler.controller.ScheduleCalendar", {

        onInit: function () {
            this._calModel = new JSONModel({ rows: [], startDate: new Date() });
            this.getView().setModel(this._calModel, "view");
            this.getRouter().getRoute("scheduleCalendar")
                .attachPatternMatched(this._load, this);
        },

        onNavBack: function () { this.getRouter().navTo("scheduleList"); },

        onViewSwitch: function (oEvt) {
            if (oEvt.getParameter("key") === "list") {
                this.getRouter().navTo("scheduleList");
            }
        },

        onRefresh: function () { this._load(); },

        _load: function () {
            var oModel = this.getModel();
            var oList = oModel.bindList("/Schedule");
            return oList.requestContexts(0, 200).then(function (aCtx) {
                var aSchedules = aCtx.map(function (c) { return c.getObject(); });
                Promise.all(aSchedules.filter(function (s) { return s.isActive && s.cronExpression; })
                    .map(this._buildRow.bind(this)))
                    .then(function (rows) {
                        this._calModel.setProperty("/rows", rows);
                    }.bind(this));
            }.bind(this));
        },

        _buildRow: function (s) {
            var qs = "?cron=" + encodeURIComponent(s.cronExpression)
                   + "&tz="   + encodeURIComponent(s.timezone || "Europe/Rome")
                   + "&count=10";
            return this.callScheduler("/preview" + qs)
                .then(function (res) {
                    var apps = (res.next || []).map(function (iso) {
                        var d = new Date(iso);
                        var end = new Date(d.getTime() + 30 * 60000);
                        return {
                            title: s.name,
                            text: s.targetType + " · " + (s.taskchain || s.jobTemplate || ""),
                            startDate: d,
                            endDate: end,
                            type: s.targetType === "DSP" ? "Type01" : (s.targetType === "IBP" ? "Type02" : "Type03")
                        };
                    });
                    return {
                        title: s.name,
                        text: s.cronExpression + " (" + (s.timezone || "Europe/Rome") + ")",
                        appointments: apps
                    };
                })
                .catch(function () {
                    return { title: s.name, text: "(invalid cron)", appointments: [] };
                });
        },

        onAppointmentSelect: function (oEvt) {
            var oApp = oEvt.getParameter("appointment");
            if (oApp) this.toast(oApp.getTitle() + "\n" + oApp.getStartDate().toLocaleString());
        }
    });
});
