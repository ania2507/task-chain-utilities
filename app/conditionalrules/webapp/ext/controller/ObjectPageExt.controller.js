sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/TextArea",
    "sap/m/Label",
    "sap/m/VBox",
    "sap/ui/core/library",
    "sap/ui/core/Fragment"
], function (ControllerExtension, MessageBox, MessageToast, Dialog, Button, TextArea, Label, VBox, coreLibrary, Fragment) {
    "use strict";

    var ValueState = coreLibrary.ValueState;

    return ControllerExtension.extend("conditionalrules.ext.controller.ObjectPageExt", {
        // this section allows to extend lifecycle hooks or override public methods of the base controller
        override: {
            onInit: function () {
                // initialization
            }
        },

        /**
         * Helper to find the CodeEditor control in the view
         */
        _getCodeEditor: function() {
            var oView = this.base.getView();
            
            // Try multiple possible IDs
            var aIds = [
                "conditionalrules::RuleTableObjectPage--fe::CustomSubSection::customCodeEditorSection--pythonCodeEditor",
                "conditionalrules::RuleTableObjectPage--fe::CustomSubSection::CodeEditorSection--pythonCodeEditor",
                "pythonCodeEditor"
            ];
            
            for (var i = 0; i < aIds.length; i++) {
                var oEditor = oView.byId(aIds[i]);
                if (oEditor) {
                    return oEditor;
                }
            }
            
            // Fallback: search by control type
            var oCodeEditor = null;
            oView.findAggregatedObjects(true, function(oControl) {
                if (oControl.getMetadata().getName() === "sap.ui.codeeditor.CodeEditor") {
                    oCodeEditor = oControl;
                    return true; // stop iteration
                }
            });
            
            return oCodeEditor;
        },

        /**
         * Helper to get code from binding context or CodeEditor
         */
        _getCode: function() {
            // First try to get from CodeEditor
            var oCodeEditor = this._getCodeEditor();
            if (oCodeEditor) {
                return oCodeEditor.getValue();
            }
            
            // Fallback: get from binding context
            var oView = this.base.getView();
            var oBindingContext = oView.getBindingContext();
            if (oBindingContext) {
                var oData = oBindingContext.getObject();
                if (oData && oData.Rule) {
                    return oData.Rule;
                }
            }
            
            return null;
        },

        /**
         * Validates the rule syntax using Python microservice.
         * Checks for syntax errors, forbidden imports, and potential issues.
         */
        onCheckSyntax: function (oEvent) {
            // Redirect to onValidateRule - they do the same thing
            this.onValidateRule(oEvent);
        },

        /**
         * Validates the rule code using the Python microservice.
         * Checks for syntax errors, forbidden imports, and potential issues.
         */
        onValidateRule: function (oEvent) {
            var that = this;
            var sCode = this._getCode();
            
            if (!sCode || sCode.trim() === "") {
                MessageToast.show("Please enter some code to validate");
                return;
            }

            // Call Python microservice /v1/rules/validate endpoint
            var sUrl = this._getPyServiceUrl() + "/v1/rules/validate";
            
            MessageToast.show("Validating rule...");
            
            this._fetchWithRetry(sUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ code: sCode })
            })
            .then(function(oResult) {
                if (oResult.valid) {
                    var sMessage = "✅ Rule is valid!";
                    if (oResult.warnings && oResult.warnings.length > 0) {
                        sMessage += "\n\n⚠️ Warnings:\n• " + oResult.warnings.join("\n• ");
                    }
                    MessageBox.success(sMessage, { title: "Validation Result" });
                } else {
                    var sErrorMsg = "❌ Validation failed:\n" + oResult.error;
                    if (oResult.line) {
                        sErrorMsg += "\n\n📍 Line: " + oResult.line;
                    }
                    MessageBox.error(sErrorMsg, { title: "Validation Error" });
                }
            })
            .catch(function(oError) {
                MessageBox.error("Error calling validation service: " + oError.message + 
                    "\n\nMake sure Python service is running on port 8080");
            });
        },

        /**
         * Opens a dialog to test the rule with a custom payload.
         */
        onTestRule: function (oEvent) {
            var that = this;
            var sCode = this._getCode();
            
            if (!sCode || sCode.trim() === "") {
                MessageToast.show("Please enter some code to test");
                return;
            }

            // Create dialog for test payload input
            var oPayloadTextArea = new TextArea({
                placeholder: '{\n  "key": "value"\n}',
                width: "100%",
                rows: 8,
                value: '{}'
            });

            var oDialog = new Dialog({
                title: "Test Rule",
                contentWidth: "500px",
                content: [
                    new VBox({
                        items: [
                            new Label({ text: "Enter test payload (JSON):", design: "Bold" }),
                            oPayloadTextArea
                        ]
                    }).addStyleClass("sapUiSmallMargin")
                ],
                beginButton: new Button({
                    text: "Run Test",
                    type: "Emphasized",
                    press: function () {
                        var sPayload = oPayloadTextArea.getValue();
                        var oPayload;
                        
                        try {
                            oPayload = JSON.parse(sPayload);
                        } catch (e) {
                            MessageBox.error("Invalid JSON payload: " + e.message);
                            return;
                        }

                        that._executeTestRule(sCode, oPayload, oDialog);
                    }
                }),
                endButton: new Button({
                    text: "Cancel",
                    press: function () {
                        oDialog.close();
                    }
                }),
                afterClose: function () {
                    oDialog.destroy();
                }
            });

            oDialog.open();
        },

        /**
         * Executes the test rule via Python microservice.
         */
        _executeTestRule: function (sCode, oPayload, oDialog) {
            var sUrl = this._getPyServiceUrl() + "/v1/rules/test";
            
            MessageToast.show("Running test...");
            
            this._fetchWithRetry(sUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ 
                    code: sCode, 
                    payload: oPayload 
                })
            })
            .then(function(oResult) {
                oDialog.close();
                
                if (oResult.success) {
                    var sMsg = "✅ Test successful!\n\n" +
                        "🎯 Taskchain: " + (oResult.taskchain || oResult.result) + "\n";
                    if (oResult.spaceId) {
                        sMsg += "🌐 SpaceId: " + oResult.spaceId + "\n";
                    }
                    sMsg += "⏱️ Execution time: " + oResult.execution_time_ms + " ms";
                    MessageBox.success(sMsg, { title: "Test Result" });
                } else {
                    var sErrMsg = "❌ Test failed:\n" + oResult.error + "\n";
                    if (oResult.spaceId) {
                        sErrMsg += "\n🌐 SpaceId: " + oResult.spaceId + "\n";
                    }
                    sErrMsg += "\n⏱️ Execution time: " + oResult.execution_time_ms + " ms";
                    MessageBox.error(sErrMsg, { title: "Test Error" });
                }
            })
            .catch(function(oError) {
                oDialog.close();
                MessageBox.error("Error calling test service: " + oError.message +
                    "\n\nMake sure Python service is running on port 8080");
            });
        },

        /**
         * Fetch wrapper with CORS mode - handles JSON responses including errors
         */
        _fetchWithRetry: function(sUrl, oOptions) {
            // Add CORS mode
            oOptions.mode = "cors";
            
            return fetch(sUrl, oOptions)
                .then(function(response) {
                    return response.json().then(function(data) {
                        // Return data along with response status
                        data._httpStatus = response.status;
                        data._httpOk = response.ok;
                        return data;
                    });
                });
        },

        /**
         * Returns the base URL for the Python microservice.
         * In development uses localhost:8080, in production routes through approuter
         */
        _getPyServiceUrl: function () {
            // Check if running in development (localhost)
            var sHost = window.location.hostname;
            if (sHost === "localhost" || sHost === "127.0.0.1") {
                // Development: Python service on port 8080
                return "http://localhost:8080";
            }
            
            // Production (managed approuter / WorkZone): resolve against the app's
            // HTML5-repo content path so the request goes through xs-app.json routing.
            return sap.ui.require.toUrl("conditionalrules");
        }
    });
});
