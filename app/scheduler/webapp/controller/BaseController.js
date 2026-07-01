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
         * Returns the absolute base URL for v1/ API calls derived from the
         * OData model's service URL (which is correctly resolved to this
         * component's URL space). This ensures fetch calls go through the
         * scheduler's own xs-app.json routing, not the host app's, even
         * when this component is embedded inside another app (e.g. home shell).
         */
        _getApiBase: function () {
            var oModel = this.getOwnerComponent().getModel();
            if (oModel && typeof oModel.getServiceUrl === "function") {
                var sServiceUrl = oModel.getServiceUrl();
                // e.g. "https://.../{guid}.scheduler-0.0.1/odata/v4/services/"
                var nIdx = sServiceUrl.lastIndexOf("/odata/");
                if (nIdx !== -1) {
                    return sServiceUrl.slice(0, nIdx + 1) + "v1/";
                }
            }
            return "v1/";
        },

        /**
         * Call the py-srv scheduler API.
         * @param {string} sPath e.g. "/run-now/<id>"
         * @param {object} [oOpts] fetch-style options
         * @returns {Promise<any>}
         */
        callScheduler: function (sPath, oOpts) {
            var sUrl = this._getApiBase() + "scheduler" + sPath;
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
