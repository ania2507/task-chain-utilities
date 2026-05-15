sap.ui.define([
    "sap/m/MessageToast",
    "sap/m/MessageStrip"
], function (MessageToast, MessageStrip) {
    "use strict";

    return {
        onCodeChange: function (oEvent) {
            var sCode = oEvent.getParameter("value");
            var oSource = oEvent.getSource();
            var oBindingContext = oSource.getBindingContext();
            
            if (oBindingContext) {
                var oModel = oBindingContext.getModel();
                oModel.setProperty(oBindingContext.getPath() + "/Rule", sCode);
            }
        },

        onCheckSyntax: function (oEvent) {
            var oButton = oEvent.getSource();
            var oView = oButton.getParent().getParent().getParent();
            
            // Trova il CodeEditor
            var oCodeEditor = null;
            var oVBox = oButton.getParent().getParent();
            var aItems = oVBox.getItems();
            
            for (var i = 0; i < aItems.length; i++) {
                if (aItems[i].isA && aItems[i].isA("sap.ui.codeeditor.CodeEditor")) {
                    oCodeEditor = aItems[i];
                    break;
                }
            }
            
            if (!oCodeEditor) {
                MessageToast.show("Code editor not found");
                return;
            }

            var sCode = oCodeEditor.getValue();
            
            if (!sCode || sCode.trim() === "") {
                MessageToast.show("No code to check");
                return;
            }

            var oBindingContext = oCodeEditor.getBindingContext();
            
            if (!oBindingContext) {
                MessageToast.show("No context available");
                return;
            }

            // Trova il MessageStrip
            var oStrip = null;
            for (var j = 0; j < aItems.length; j++) {
                if (aItems[j].isA && aItems[j].isA("sap.m.MessageStrip")) {
                    oStrip = aItems[j];
                    break;
                }
            }

            // Chiama il backend per il syntax check
            var oModel = oBindingContext.getModel();
            var oAction = oModel.bindContext(oBindingContext.getPath() + "/Services.checkSyntax(...)");
            
            oAction.setParameter("code", sCode);
            
            oAction.invoke().then(function () {
                var oResult = oAction.getBoundContext().getObject();
                if (oStrip) {
                    oStrip.setVisible(true);
                    oStrip.setType(oResult.valid ? "Success" : "Error");
                    oStrip.setText(oResult.valid ? "Syntax OK! ✓" : oResult.message);
                } else {
                    MessageToast.show(oResult.valid ? "Syntax OK!" : oResult.message);
                }
            }).catch(function (oError) {
                var sMessage = "Error checking syntax";
                if (oStrip) {
                    oStrip.setVisible(true);
                    oStrip.setType("Error");
                    oStrip.setText(sMessage);
                } else {
                    MessageToast.show(sMessage);
                }
            });
        }
    };
});
