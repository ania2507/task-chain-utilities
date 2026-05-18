sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/ui/core/routing/History"
], function (Controller, JSONModel, MessageToast, History) {
    "use strict";

    return Controller.extend("monitoring.controller.RunInspector", {
        
        onInit: function () {
            var oRouter = this.getOwnerComponent().getRouter();
            oRouter.getRoute("runInspector").attachPatternMatched(this._onRouteMatched, this);
        },

        /**
         * Called when the route pattern is matched
         * @param {sap.ui.base.Event} oEvent - The route matched event
         */
        _onRouteMatched: function (oEvent) {
            var oArgs = oEvent.getParameter("arguments");
            this._sProjectId = oArgs.projectId;
            this._sChainId = oArgs.chainId;
            this._sRunId = oArgs.runId;
            this._loadRunData();
        },

        /**
         * Load run execution data
         */
        _loadRunData: function () {
            var oView = this.getView();
            var sRunId = decodeURIComponent(this._sRunId);
            var sChainId = decodeURIComponent(this._sChainId);
            
            // Get project data to find spaceId
            var aProjects = JSON.parse(localStorage.getItem("monitoringProjects") || "[]");
            var oProject = aProjects.find(function(p) { return p.id === this._sProjectId; }.bind(this));
            var sSpaceId = "";
            
            if (oProject && oProject.taskChains) {
                var oChain = oProject.taskChains.find(function(tc) { 
                    return tc.name === sChainId || tc.id === sChainId; 
                });
                if (oChain) {
                    sSpaceId = oChain.spaceId || "";
                }
            }
            
            // Create initial model with loading state
            var oRunDetailModel = new JSONModel({
                runId: sRunId,
                taskChainName: sChainId,
                spaceId: sSpaceId,
                status: "loading",
                statusText: "Loading...",
                startTime: "-",
                endTime: "-",
                totalDuration: "-",
                retryCount: 0,
                correlationId: "",
                errorMessage: "",
                errorCode: "",
                failedTask: "",
                stackTrace: "",
                timeline: [],
                retries: [],
                failedSteps: [],
                failedStepsCount: 0
            });
            
            oView.setModel(oRunDetailModel, "runDetail");
            
            // Load run details from DSP
            this._loadRunDetails(sRunId, sChainId, sSpaceId, oRunDetailModel);
        },
        
        /**
         * Load run details from DSP API
         */
        _loadRunDetails: function(sRunId, sChainId, sSpaceId, oModel) {
            this.getOwnerComponent()._setBusy(true);
            var sBaseUrl = this._getPySrvUrl();
            var that = this;
            
            // Get run info from taskchain-runs
            var sRunsUrl = sBaseUrl + "/v1/dsp/taskchain-runs?spaceId=" + encodeURIComponent(sSpaceId) + 
                       "&taskchain=" + encodeURIComponent(sChainId) + 
                       "&limit=800";
            
            // Get detailed messages for this run
            var sMessagesUrl = sBaseUrl + "/v1/dsp/tasklog-messages?taskLogId=" + encodeURIComponent(sRunId);
            
            // Get child nodes info (to find failed child tasks)
            var sNodesUrl = sBaseUrl + "/v1/dsp/taskchain-run-nodes?chainTaskLogId=" + encodeURIComponent(sRunId);
            
            Promise.all([
                that._fetchDsp(sRunsUrl).then(function(r) { return r.json(); }),
                that._fetchDsp(sMessagesUrl).then(function(r) { return r.json(); }).catch(function() { return { success: false, messages: [] }; }),
                that._fetchDsp(sNodesUrl).then(function(r) { return r.json(); }).catch(function() { return { success: false, nodes: [] }; })
            ]).then(function(results) {
                var runsResult = results[0];
                var messagesResult = results[1];
                var nodesResult = results[2];
                
                // Find the specific run
                var oRun = null;
                if (runsResult.success && runsResult.runs) {
                    oRun = runsResult.runs.find(function(r) { 
                        return String(r.runId) === String(sRunId); 
                    });
                }
                
                if (oRun) {
                    var sStatus = oRun.status;
                    var sStatusText = sStatus === "success" ? "Success" : 
                                     sStatus === "error" ? "Error" : 
                                     sStatus === "running" ? "Running" : "Pending";
                    
                    // Calculate duration
                    var sDuration = "-";
                    if (oRun.duration && typeof oRun.duration === "number") {
                        var mins = Math.floor(oRun.duration);
                        var secs = Math.round((oRun.duration - mins) * 60);
                        sDuration = mins + " min " + secs + " sec";
                    } else if (oRun.durationDisplay) {
                        sDuration = oRun.durationDisplay;
                    }
                    
                    oModel.setProperty("/status", sStatus);
                    oModel.setProperty("/statusText", sStatusText);
                    oModel.setProperty("/startTime", oRun.startTime || "-");
                    oModel.setProperty("/endTime", oRun.endTime || "-");
                    oModel.setProperty("/totalDuration", sDuration);
                }
                
                // Process messages into timeline
                var aTimeline = [];
                var sErrorMessage = "";
                var sErrorCode = "";
                var sCorrelationId = "";
                
                if (messagesResult.success && messagesResult.messages) {
                    messagesResult.messages.forEach(function(msg) {
                        // Extract correlation ID from details
                        if (msg.details && msg.details.correlationId && !sCorrelationId) {
                            sCorrelationId = msg.details.correlationId;
                        }
                        
                        // Build timeline entry
                        aTimeline.push({
                            taskName: msg.details && msg.details.task ? msg.details.task.split("/").pop() : (msg.messageKey || "Message"),
                            timestamp: msg.timestamp,
                            status: msg.severity === "ERROR" ? "error" : msg.severity === "WARNING" ? "warning" : "success",
                            message: msg.text
                        });
                        
                        // Capture error details from main chain messages
                        if (msg.severity === "ERROR") {
                            if (!sErrorMessage) {
                                sErrorMessage = msg.text;
                            }
                            if (msg.details && msg.details.errorMessage) {
                                sErrorMessage = msg.details.errorMessage;
                            }
                            if (msg.details && msg.details.code) {
                                sErrorCode = "SQL-" + msg.details.code;
                            }
                        }
                    });
                }
                
                // If no error found yet but run failed, check child nodes for errors
                // Also check for failed steps even if run is still running
                var aFailedNodes = [];
                if (nodesResult.success && nodesResult.nodes) {
                    aFailedNodes = nodesResult.nodes.filter(function(n) {
                        return n.status === "error";
                    });
                    
                    // Populate failed steps immediately (will be enhanced with error messages)
                    var aFailedSteps = aFailedNodes.map(function(node) {
                        var sDurationDisplay = "-";
                        if (node.duration && typeof node.duration === "number") {
                            sDurationDisplay = node.duration.toFixed(2) + " min";
                        }
                        return {
                            objectId: node.objectId || "Node " + node.nodeId,
                            status: node.status,
                            taskLogId: node.taskLogId,
                            startTime: node.startTime,
                            endTime: node.endTime,
                            duration: node.duration || 0,
                            durationDisplay: sDurationDisplay,
                            errorMessage: "Loading error details..."
                        };
                    });
                    
                    oModel.setProperty("/failedSteps", aFailedSteps);
                    oModel.setProperty("/failedStepsCount", aFailedSteps.length);
                    
                    // Also set failedTask for the error panel
                    if (aFailedSteps.length > 0) {
                        oModel.setProperty("/failedTask", aFailedSteps.map(function(s) { return s.objectId; }).join(", "));
                    }
                }
                
                // Fetch error messages for failed nodes
                if (aFailedNodes.length > 0) {
                    var aNodesWithLogs = aFailedNodes.filter(function(n) { return n.taskLogId; });
                    
                    if (aNodesWithLogs.length > 0) {
                        // Fetch error messages from failed child tasks
                        var aChildPromises = aNodesWithLogs.map(function(node) {
                            return that._fetchDsp(sBaseUrl + "/v1/dsp/tasklog-messages?taskLogId=" + node.taskLogId)
                                .then(function(r) { return r.json(); })
                                .catch(function() { return { success: false, messages: [] }; });
                        });
                        
                        Promise.all(aChildPromises).then(function(childResults) {
                            var aUpdatedFailedSteps = oModel.getProperty("/failedSteps") || [];
                            
                            childResults.forEach(function(childMsgResult, idx) {
                                var failedNode = aNodesWithLogs[idx];
                                var sNodeError = "";
                                
                                if (childMsgResult.success && childMsgResult.messages) {
                                    childMsgResult.messages.forEach(function(msg) {
                                        if (msg.severity === "ERROR") {
                                            // Add to timeline
                                            aTimeline.push({
                                                taskName: failedNode.objectId || "Child Task " + failedNode.nodeId,
                                                timestamp: msg.timestamp,
                                                status: "error",
                                                message: msg.text
                                            });
                                            
                                            // Capture error message for this node
                                            if (!sNodeError) {
                                                sNodeError = msg.text;
                                            }
                                            if (msg.details && msg.details.errorMessage) {
                                                sNodeError = msg.details.errorMessage;
                                            }
                                            
                                            // Capture main error details if not set
                                            if (!sErrorMessage) {
                                                sErrorMessage = msg.text;
                                            }
                                            if (msg.details && msg.details.code && !sErrorCode) {
                                                sErrorCode = "SQL-" + msg.details.code;
                                            }
                                            if (msg.details && msg.details.correlationId && !sCorrelationId) {
                                                sCorrelationId = msg.details.correlationId;
                                            }
                                        }
                                    });
                                }
                                
                                // Update the failed step with error message
                                var iStepIndex = aUpdatedFailedSteps.findIndex(function(s) {
                                    return s.taskLogId === failedNode.taskLogId;
                                });
                                if (iStepIndex >= 0) {
                                    aUpdatedFailedSteps[iStepIndex].errorMessage = sNodeError || "No error message available";
                                }
                            });
                            
                            // Sort timeline by timestamp
                            aTimeline.sort(function(a, b) {
                                return new Date(a.timestamp) - new Date(b.timestamp);
                            });
                            
                            oModel.setProperty("/failedSteps", aUpdatedFailedSteps);
                            oModel.setProperty("/timeline", aTimeline);
                            oModel.setProperty("/correlationId", sCorrelationId || "corr-" + sRunId);
                            oModel.setProperty("/errorMessage", sErrorMessage);
                            oModel.setProperty("/errorCode", sErrorCode);
                            that.getOwnerComponent()._setBusy(false);
                        });
                        return; // Exit early, child promises will update model
                    }
                }
                
                // If no messages, create basic timeline from run info
                if (aTimeline.length === 0 && oRun) {
                    aTimeline.push({
                        taskName: sChainId,
                        timestamp: oRun.startTime,
                        status: oRun.status,
                        message: oRun.status === "success" ? 
                            "Task chain completed successfully." :
                            oRun.status === "error" ? 
                            "Task chain execution failed." :
                            "Task chain is running..."
                    });
                }
                
                oModel.setProperty("/timeline", aTimeline);
                oModel.setProperty("/correlationId", sCorrelationId || "corr-" + sRunId);
                oModel.setProperty("/errorMessage", sErrorMessage);
                oModel.setProperty("/errorCode", sErrorCode);
                that.getOwnerComponent()._setBusy(false);

            }.bind(this)).catch(function(error) {
                console.error("Error loading run details:", error);
                oModel.setProperty("/status", "error");
                oModel.setProperty("/statusText", "Load Error");
                that.getOwnerComponent()._setBusy(false);
            });
        },
        
        /**
         * Get py-srv URL
         */
        _getPySrvUrl: function () {
            var sHost = window.location.hostname;
            if (sHost === "localhost" || sHost === "127.0.0.1") {
                return "http://localhost:8080";
            }
            // In production (managed approuter / WorkZone), resolve relative to the
            // app's manifest base URL so the request goes through xs-app.json routing.
            var sBaseUri = this.getOwnerComponent().getManifestObject().resolveUri("");
            // Strip query parameters injected by the Launchpad iframe context
            var iQuery = sBaseUri.indexOf("?");
            if (iQuery > -1) {
                sBaseUri = sBaseUri.substring(0, iQuery);
            }
            return sBaseUri.replace(/\/$/, "");
        },

        /**
         * Fetch wrapper for DSP API calls - includes credentials for XSUAA auth in production
         */
        _fetchDsp: function (sUrl) {
            return fetch(sUrl, { credentials: "same-origin" });
        },

        /**
         * Navigate back
         */
        onNavBack: function () {
            var oHistory = History.getInstance();
            var sPreviousHash = oHistory.getPreviousHash();

            if (sPreviousHash !== undefined) {
                window.history.go(-1);
            } else {
                this.getOwnerComponent().getRouter().navTo("taskChainDetail", {
                    projectId: this._sProjectId,
                    chainId: this._sChainId
                }, true);
            }
        },

        /**
         * Refresh run data
         */
        onRefresh: function () {
            MessageToast.show("Refreshing run data...");
            this._loadRunData();
        },

        /**
         * View logs in external system
         */
        onViewLogs: function () {
            var sCorrelationId = this.getView().getModel("runDetail").getProperty("/correlationId");
            MessageToast.show("Opening logs for correlation ID: " + sCorrelationId);
            // TODO: Implement actual log viewer integration
        },

        /**
         * View correlated logs
         */
        onViewCorrelatedLogs: function () {
            var sCorrelationId = this.getView().getModel("runDetail").getProperty("/correlationId");
            MessageToast.show("Opening correlated logs: " + sCorrelationId);
            // TODO: Implement actual log correlation feature
        },

        /**
         * View full execution logs
         */
        onViewFullLogs: function () {
            MessageToast.show("Opening full execution logs...");
            // TODO: Implement full logs viewer
        },

        /**
         * Handle click on failed step - show error detail dialog
         */
        onFailedStepPress: function (oEvent) {
            var oBindingContext = oEvent.getSource().getBindingContext("runDetail");
            var oStep = oBindingContext.getObject();
            
            // Create and open dialog with error details
            if (!this._oFailedStepDialog) {
                this._oFailedStepDialog = new sap.m.Dialog({
                    title: "Failed Step Details",
                    contentWidth: "600px",
                    content: [
                        new sap.m.VBox({
                            id: this.createId("failedStepDialogContent"),
                            items: []
                        }).addStyleClass("sapUiSmallMargin")
                    ],
                    beginButton: new sap.m.Button({
                        text: "Close",
                        press: function () {
                            this._oFailedStepDialog.close();
                        }.bind(this)
                    })
                });
                this.getView().addDependent(this._oFailedStepDialog);
            }
            
            // Build content
            var oContentBox = this.byId("failedStepDialogContent");
            oContentBox.removeAllItems();
            
            oContentBox.addItem(new sap.m.HBox({
                items: [
                    new sap.ui.core.Icon({ src: "sap-icon://error", color: "#bb0000", size: "2rem" }).addStyleClass("sapUiSmallMarginEnd"),
                    new sap.m.Title({ text: oStep.objectId, level: "H4" })
                ],
                alignItems: "Center"
            }).addStyleClass("sapUiSmallMarginBottom"));
            
            oContentBox.addItem(this._createDetailRow("Status", oStep.status.toUpperCase()));
            oContentBox.addItem(this._createDetailRow("Start Time", oStep.startTime || "-"));
            oContentBox.addItem(this._createDetailRow("End Time", oStep.endTime || "-"));
            oContentBox.addItem(this._createDetailRow("Duration", oStep.durationDisplay));
            oContentBox.addItem(this._createDetailRow("Task Log ID", oStep.taskLogId ? String(oStep.taskLogId) : "-"));
            
            // Error message
            oContentBox.addItem(new sap.m.Label({ text: "Error Message:", design: "Bold" }).addStyleClass("sapUiSmallMarginTop"));
            oContentBox.addItem(new sap.m.MessageStrip({
                text: oStep.errorMessage || "No error message available",
                type: "Error",
                showIcon: true
            }).addStyleClass("sapUiTinyMarginTop"));
            
            this._oFailedStepDialog.setTitle("Failed Step: " + oStep.objectId);
            this._oFailedStepDialog.open();
        },

        /**
         * Create a detail row for dialog
         */
        _createDetailRow: function (sLabel, sValue) {
            return new sap.m.HBox({
                items: [
                    new sap.m.Label({ text: sLabel + ":", design: "Bold", width: "100px" }),
                    new sap.m.Text({ text: sValue || "-" })
                ]
            }).addStyleClass("sapUiTinyMarginBottom");
        }
    });
});
