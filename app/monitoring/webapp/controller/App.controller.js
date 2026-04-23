sap.ui.define([
    "./BaseController"
], function (BaseController) {
    "use strict";

    return BaseController.extend("monitoring.controller.App", {
        onInit: function () {
            // Apply content density mode (compact/cozy) based on device
            this.getView().addStyleClass(this.getOwnerComponent().getContentDensityClass());
        }
    });
});
