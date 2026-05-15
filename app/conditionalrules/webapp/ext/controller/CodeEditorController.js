sap.ui.define([
    "sap/m/MessageBox",
    "sap/m/MessageToast"
], function (MessageBox, MessageToast) {
    "use strict";

    return {
        onCheckSyntax: function (oEvent) {
            var oBindingContext = this.getBindingContext();
            
            if (!oBindingContext) {
                MessageToast.show("No context available");
                return;
            }

            var oModel = oBindingContext.getModel();
            var sPath = oBindingContext.getPath();

            // Call the bound action checkSyntax
            var oOperation = oModel.bindContext(sPath + "/Services.checkSyntax(...)");
            
            oOperation.execute().then(function () {
                var oResult = oOperation.getBoundContext().getObject();
                
                if (oResult.valid) {
                    MessageBox.success(oResult.message || "Python syntax is valid!");
                } else {
                    var sErrorMsg = oResult.message || "Syntax error";
                    if (oResult.line) {
                        sErrorMsg += "\nLine: " + oResult.line;
                    }
                    if (oResult.column) {
                        sErrorMsg += ", Column: " + oResult.column;
                    }
                    MessageBox.error(sErrorMsg);
                }
            }).catch(function (oError) {
                MessageBox.error("Error checking syntax: " + oError.message);
            });
        }
    };
});
