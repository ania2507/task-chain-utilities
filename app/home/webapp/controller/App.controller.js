sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/ComponentContainer",
    "sap/ui/core/Component",
    "sap/ui/core/routing/HashChanger"
], function (Controller, ComponentContainer, Component, HashChanger) {
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
        _oPreloadedComponents: null,

        onInit: function () {
            // BTP Launchpad URL pattern: /{guid}.{service}.{appId}-{version}/index.html
            // Extract the prefix (guid + service) from the current page URL so we
            // can build sibling-app URLs dynamically — works after every redeploy.
            var sSegment = window.location.pathname.split('/')[1] || "";
            var oMatch = sSegment.match(/^(.+)\.home-[\d.]+$/);
            if (oMatch) {
                this._sLaunchpadPrefix = oMatch[1];
            }
            this._oPreloadedComponents = {};
            this._selectNavItem("home");

            // Start background preloading after the home page has rendered
            setTimeout(this._preloadApps.bind(this), 1500);
        },

        _buildUrl: function (oCfg) {
            if (this._sLaunchpadPrefix) {
                return "/" + this._sLaunchpadPrefix + "." + oCfg.name + "-" + oCfg.version + "/";
            }
            return oCfg.localUrl;
        },

        _preloadApps: function () {
            var that = this;
            Object.keys(APP_CONFIG).forEach(function (sKey) {
                var oCfg = APP_CONFIG[sKey];
                Component.create({
                    name: oCfg.name,
                    url: that._buildUrl(oCfg),
                    manifest: true
                }).then(function (oComponent) {
                    that._oPreloadedComponents[sKey] = oComponent;
                }).catch(function () {
                    // Silently ignore — _loadApp will retry on demand if needed
                });
            });
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

            var oPreloaded = this._oPreloadedComponents[sKey];
            if (oPreloaded) {
                // Already loaded in background — mount immediately, no spinner needed
                delete this._oPreloadedComponents[sKey];
                fnMount(oPreloaded);
            } else {
                this.byId("toolPage").setBusy(true);
                Component.create({
                    name: oCfg.name,
                    url: this._buildUrl(oCfg),
                    manifest: true
                }).then(fnMount).catch(fnError);
            }
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

                // Sub-apps share the browser's hash-based router. Leaving a deep
                // link (e.g. "project/12/chain/3") in place makes the next app's
                // router fail to match any of its own routes, rendering blank.
                // Reset it so the next app always starts at its default route.
                HashChanger.getInstance().setHash("");
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
            var oCache = this._oPreloadedComponents || {};
            Object.keys(oCache).forEach(function (sKey) {
                oCache[sKey].destroy();
            });
        }
    });
});
