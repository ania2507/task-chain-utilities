sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast",
    "sap/m/MessageBox"
], function (Controller, MessageToast, MessageBox) {
    "use strict";

    return Controller.extend("scheduler.controller.BaseController", {

        getRouter: function () {
            return this.getOwnerComponent().getRouter();
        },

        getResourceBundle: function () {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle();
        },

        getModel: function (name) {
            return this.getView().getModel(name);
        },

        i18n: function (key, args) {
            return this.getResourceBundle().getText(key, args || []);
        },

        toast: function (msg) {
            MessageToast.show(msg);
        },

        error: function (msg) {
            MessageBox.error(msg);
        },

        /**
         * Call the py-srv scheduler API.
         * @param {string} sPath e.g. "/run-now/<id>"
         * @param {object} [oOpts] fetch-style options
         * @returns {Promise<any>}
         */
        callScheduler: function (sPath, oOpts) {
            var sUrl = "v1/scheduler" + sPath;
            var opts = Object.assign({
                method: "GET",
                headers: { "Content-Type": "application/json" }
            }, oOpts || {});
            return fetch(sUrl, opts).then(function (res) {
                return res.text().then(function (txt) {
                    var data;
                    try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { raw: txt }; }
                    if (!res.ok) {
                        var err = new Error((data && data.error) || ("HTTP " + res.status));
                        err.status = res.status;
                        throw err;
                    }
                    return data;
                });
            });
        }
    });
});
