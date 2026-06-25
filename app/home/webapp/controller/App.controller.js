sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/ComponentContainer",
    "sap/ui/core/Component"
], function (Controller, ComponentContainer, Component) {
    "use strict";

    var APP_CONFIG = {
        monitoring:       { name: "monitoring",       version: "0.0.1", localUrl: "/monitoring/" },
        scheduler:        { name: "scheduler",        version: "0.0.1", localUrl: "/scheduler/" },
        skipoverrides:    { name: "skipoverrides",    version: "0.0.1", localUrl: "/skipoverrides/" },
        conditionalrules: { name: "conditionalrules", version: "0.0.1", localUrl: "/conditionalrules/" }
    };

    return Controller.extend("home.controller.App", {

        _oCurrentContainer: null,
        _sLaunchpadPrefix: null,

        onInit: function () {
            // BTP Launchpad URL pattern: /{guid}.{service}.{appId}-{version}/index.html
            // Extract the prefix (guid + service) from the current page URL so we
            // can build sibling-app URLs dynamically — works after every redeploy.
            var sSegment = window.location.pathname.split('/')[1] || "";
            var oMatch = sSegment.match(/^(.+)\.home-[\d.]+$/);
            if (oMatch) {
                this._sLaunchpadPrefix = oMatch[1];
            }
            this._selectNavItem("home");
        },

        onToggleSidebar: function () {
            var oToolPage = this.byId("toolPage");
            oToolPage.setSideExpanded(!oToolPage.getSideExpanded());
        },

        onNavItemSelect: function (oEvent) {
            var sKey = oEvent.getParameter("item").getKey();
            if (sKey === "home") {
                this._showWelcome();
            } else {
                this._loadApp(sKey);
            }
        },

        onTilePress: function (oEvent) {
            var sKey = oEvent.getSource().getCustomData()[0].getValue();
            this._loadApp(sKey);
            this._selectNavItem(sKey);
        },

        _showWelcome: function () {
            this._destroyCurrentApp();
            this.byId("welcomeContainer").setVisible(true);
            this._selectNavItem("home");
        },

        _loadApp: function (sKey) {
            var that = this;
            var oCfg = APP_CONFIG[sKey];

            this.byId("welcomeContainer").setVisible(false);
            this._destroyCurrentApp();
            this.byId("toolPage").setBusy(true);

            var fnMount = function (oComponent) {
                var oContainer = new ComponentContainer({
                    component: oComponent,
                    height: "100%",
                    width: "100%"
                });
                that._oCurrentContainer = oContainer;
                that.byId("toolPage").addMainContent(oContainer);
                that.byId("toolPage").setBusy(false);
            };

            var fnError = function (oError) {
                console.error("[Home] Failed to load [" + sKey + "]:", oError);
                that.byId("toolPage").setBusy(false);
                that._showWelcome();
            };

            var sUrl;
            if (this._sLaunchpadPrefix) {
                // BTP Launchpad: build URL from the guid+service prefix extracted in onInit
                // e.g. /4ea149ad-...taskchainutilitiesservice.monitoring-0.0.1/
                sUrl = "/" + this._sLaunchpadPrefix + "." + oCfg.name + "-" + oCfg.version + "/";
            } else {
                // Local dev / standalone approuter
                sUrl = oCfg.localUrl;
            }
            Component.create({
                name: oCfg.name,
                url: sUrl,
                manifest: true
            }).then(fnMount).catch(fnError);
        },

        _destroyCurrentApp: function () {
            if (this._oCurrentContainer) {
                var oComponent = this._oCurrentContainer.getComponentInstance();
                this.byId("toolPage").removeMainContent(this._oCurrentContainer);
                this._oCurrentContainer.destroy();
                if (oComponent) {
                    oComponent.destroy();
                }
                this._oCurrentContainer = null;
            }
        },

        _selectNavItem: function (sKey) {
            var oNavList = this.byId("sideNav").getItem();
            var oTarget = oNavList.getItems().find(function (oItem) {
                return oItem.getKey() === sKey;
            });
            if (oTarget) {
                oNavList.setSelectedItem(oTarget);
            }
        },

        onExit: function () {
            this._destroyCurrentApp();
        }
    });
});
