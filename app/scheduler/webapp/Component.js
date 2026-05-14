sap.ui.define([
    "sap/ui/core/UIComponent",
    "sap/ui/model/json/JSONModel",
    "sap/ui/Device"
], function (UIComponent, JSONModel, Device) {
    "use strict";

    return UIComponent.extend("scheduler.Component", {
        metadata: { manifest: "json" },

        init: function () {
            UIComponent.prototype.init.apply(this, arguments);

            var oDeviceModel = new JSONModel(Device);
            oDeviceModel.setDefaultBindingMode("OneWay");
            this.setModel(oDeviceModel, "device");

            // Shared view model for transient UI state (selected schedule, dialogs, etc.)
            this.setModel(new JSONModel({
                selected: null,
                preview: [],
                busy: false
            }), "view");

            this.getRouter().initialize();
        }
    });
});
