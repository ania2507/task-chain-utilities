sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/routing/History",
    "sap/ui/model/json/JSONModel",
    "monitoring/model/formatter"
], function (Controller, History, JSONModel, formatter) {
    "use strict";

    /**
     * Base Controller with common functionality for all monitoring views
     * Reuses patterns from existing webapp controllers
     */
    return Controller.extend("monitoring.controller.BaseController", {
        
        /**
         * Formatter module reference
         */
        formatter: formatter,

        /**
         * Convenience method for getting the view model by name
         * @param {string} sName - The model name
         * @returns {sap.ui.model.Model} The model instance
         */
        getModel: function (sName) {
            return this.getView().getModel(sName);
        },

        /**
         * Convenience method for setting the view model
         * @param {sap.ui.model.Model} oModel - The model instance
         * @param {string} sName - The model name
         * @returns {sap.ui.core.mvc.View} The view instance
         */
        setModel: function (oModel, sName) {
            return this.getView().setModel(oModel, sName);
        },

        /**
         * Convenience method for getting the resource bundle
         * @returns {sap.base.i18n.ResourceBundle} The resource bundle
         */
        getResourceBundle: function () {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle();
        },

        /**
         * Convenience method for getting the router
         * @returns {sap.ui.core.routing.Router} The router instance
         */
        getRouter: function () {
            return this.getOwnerComponent().getRouter();
        },

        /**
         * Navigate back with fallback
         * @param {string} sFallbackRoute - The fallback route name
         * @param {object} oFallbackParams - The fallback route parameters
         */
        onNavBack: function (sFallbackRoute, oFallbackParams) {
            var oHistory = History.getInstance();
            var sPreviousHash = oHistory.getPreviousHash();

            if (sPreviousHash !== undefined) {
                window.history.go(-1);
            } else if (sFallbackRoute) {
                this.getRouter().navTo(sFallbackRoute, oFallbackParams || {}, true);
            } else {
                this.getRouter().navTo("projectList", {}, true);
            }
        },

        /**
         * Make an API call to the Python backend
         * @param {string} sEndpoint - The API endpoint
         * @param {string} sMethod - HTTP method (GET, POST, etc.)
         * @param {object} oData - Request data for POST/PUT
         * @returns {Promise} The fetch promise
         */
        callApi: function (sEndpoint, sMethod, oData) {
            var sUrl = "/api" + sEndpoint;
            var oOptions = {
                method: sMethod || "GET",
                headers: {
                    "Content-Type": "application/json"
                }
            };
            
            if (oData && (sMethod === "POST" || sMethod === "PUT")) {
                oOptions.body = JSON.stringify(oData);
            }
            
            return fetch(sUrl, oOptions).then(function(response) {
                if (!response.ok) {
                    throw new Error("API call failed: " + response.statusText);
                }
                return response.json();
            });
        },

        /**
         * Show a busy indicator on the view
         * @param {boolean} bBusy - Whether to show or hide
         */
        setBusy: function (bBusy) {
            this.getView().setBusy(bBusy);
        },

        /**
         * Create a JSON model and set it to the view
         * @param {object} oData - The model data
         * @param {string} sName - The model name
         * @returns {sap.ui.model.json.JSONModel} The created model
         */
        createViewModel: function (oData, sName) {
            var oModel = new JSONModel(oData);
            this.setModel(oModel, sName);
            return oModel;
        }
    });
});
