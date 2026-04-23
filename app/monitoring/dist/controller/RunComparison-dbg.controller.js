sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/Column",
    "sap/m/Text",
    "sap/m/ObjectStatus",
    "sap/m/VBox",
    "sap/m/HBox",
    "sap/m/Label",
    "sap/f/Card",
    "sap/ui/core/Icon"
], function (Controller, JSONModel, Column, Text, ObjectStatus, VBox, HBox, Label, Card, Icon) {
    "use strict";

    return Controller.extend("monitoring.controller.RunComparison", {

        onInit: function () {
            var oRouter = this.getOwnerComponent().getRouter();
            oRouter.getRoute("runComparison").attachPatternMatched(this._onRouteMatched, this);
        },

        _onRouteMatched: function (oEvent) {
            var oArgs = oEvent.getParameter("arguments");
            this._sProjectId = oArgs.projectId;
            
            // Get run IDs from query parameter
            var sRunIds = oArgs["?query"] && oArgs["?query"].runs;
            this._aRunIds = sRunIds ? sRunIds.split(",") : [];
            
            if (this._aRunIds.length < 2) {
                sap.m.MessageToast.show("At least 2 runs required for comparison");
                this.onNavBack();
                return;
            }
            
            this._initModel();
            this._loadRunsData();
        },

        _initModel: function () {
            var oCompareModel = new JSONModel({
                projectId: this._sProjectId,
                runCount: this._aRunIds.length,
                runs: [],
                steps: [],
                stats: {
                    successRate: 0,
                    avgDuration: 0,
                    minDuration: 0,
                    maxDuration: 0,
                    durationVariance: 0
                },
                anomalies: [],
                viewMode: "table",
                loading: true
            });
            this.getView().setModel(oCompareModel, "compare");
        },

        _loadRunsData: function () {
            var that = this;
            var oModel = this.getView().getModel("compare");
            var sBaseUrl = this._getPySrvUrl();
            
            // Load data for each run in parallel
            var aPromises = this._aRunIds.map(function (sRunId) {
                return that._loadSingleRunData(sRunId, sBaseUrl);
            });
            
            Promise.all(aPromises).then(function (aResults) {
                var aValidRuns = aResults.filter(function (r) { return r !== null; });
                
                oModel.setProperty("/runs", aValidRuns);
                oModel.setProperty("/runCount", aValidRuns.length);
                
                // Calculate statistics
                that._calculateStats(aValidRuns, oModel);
                
                // Build step comparison
                that._buildStepComparison(aValidRuns, oModel);
                
                // Detect anomalies
                that._detectAnomalies(aValidRuns, oModel);
                
                // Build UI cards
                that._buildSummaryCards(aValidRuns);
                
                // Build comparison table columns
                that._buildComparisonTableColumns(aValidRuns);
                
                oModel.setProperty("/loading", false);
            }).catch(function (error) {
                console.error("Error loading runs:", error);
                oModel.setProperty("/loading", false);
            });
        },

        _loadSingleRunData: function (sRunId, sBaseUrl) {
            var that = this;
            
            // Load run details and nodes
            return Promise.all([
                that._fetchDsp(sBaseUrl + "/v1/dsp/taskchain-runs?limit=1000").then(function(r) { return r.json(); }),
                that._fetchDsp(sBaseUrl + "/v1/dsp/taskchain-run-nodes?chainTaskLogId=" + encodeURIComponent(sRunId)).then(function(r) { return r.json(); })
            ]).then(function (aResponses) {
                var oRunsResult = aResponses[0];
                var oNodesResult = aResponses[1];
                
                // Find the specific run
                var oRun = null;
                if (oRunsResult.success && oRunsResult.runs) {
                    oRun = oRunsResult.runs.find(function (r) {
                        return String(r.runId) === String(sRunId);
                    });
                }
                
                if (!oRun) {
                    console.warn("Run not found:", sRunId);
                    return null;
                }
                
                // Attach nodes to run
                oRun.nodes = oNodesResult.success ? oNodesResult.nodes : [];
                
                return oRun;
            }).catch(function (error) {
                console.error("Error loading run " + sRunId + ":", error);
                return null;
            });
        },

        _calculateStats: function (aRuns, oModel) {
            var iSuccessCount = aRuns.filter(function (r) { return r.status === "success"; }).length;
            var fSuccessRate = aRuns.length > 0 ? (iSuccessCount / aRuns.length * 100) : 0;
            
            var aDurations = aRuns
                .filter(function (r) { return r.duration && typeof r.duration === "number"; })
                .map(function (r) { return r.duration; });
            
            var fAvg = 0, fMin = 0, fMax = 0, fVariance = 0;
            if (aDurations.length > 0) {
                fMin = Math.min.apply(null, aDurations);
                fMax = Math.max.apply(null, aDurations);
                fAvg = aDurations.reduce(function (a, b) { return a + b; }, 0) / aDurations.length;
                fVariance = fMax - fMin;
            }
            
            oModel.setProperty("/stats", {
                successRate: fSuccessRate.toFixed(1),
                avgDuration: fAvg.toFixed(1),
                minDuration: fMin.toFixed(1),
                maxDuration: fMax.toFixed(1),
                durationVariance: fVariance.toFixed(1)
            });
        },

        _buildStepComparison: function (aRuns, oModel) {
            // Collect all unique task names across all runs
            var oTaskMap = {};
            
            aRuns.forEach(function (oRun, iRunIndex) {
                (oRun.nodes || []).forEach(function (oNode) {
                    var sTaskName = oNode.objectId || oNode.taskName || ("Node_" + oNode.nodeId);
                    
                    if (!oTaskMap[sTaskName]) {
                        oTaskMap[sTaskName] = {
                            taskName: sTaskName,
                            type: oNode.taskType || "TASK",
                            runs: {}
                        };
                    }
                    
                    oTaskMap[sTaskName].runs["run_" + iRunIndex] = {
                        status: oNode.status || "unknown",
                        duration: oNode.duration || 0,
                        startTime: oNode.startTime,
                        endTime: oNode.endTime,
                        taskLogId: oNode.taskLogId
                    };
                });
            });
            
            // Convert to array and calculate stats for each step
            var aSteps = Object.values(oTaskMap).map(function(oStep) {
                var aDurations = Object.values(oStep.runs)
                    .filter(function(r) { return r.duration && r.duration > 0; })
                    .map(function(r) { return r.duration; });
                
                var fMinDuration = aDurations.length > 0 ? Math.min.apply(null, aDurations) : 0;
                var fMaxDuration = aDurations.length > 0 ? Math.max.apply(null, aDurations) : 0;
                var fAvgDuration = aDurations.length > 0 ? 
                    aDurations.reduce(function(a, b) { return a + b; }, 0) / aDurations.length : 0;
                var fVariance = fMaxDuration - fMinDuration;
                var fVariancePct = fAvgDuration > 0 ? ((fVariance / fAvgDuration) * 100) : 0;
                
                oStep.minDuration = fMinDuration;
                oStep.maxDuration = fMaxDuration;
                oStep.avgDuration = fAvgDuration;
                oStep.durationVariance = fVariance;
                oStep.variancePct = fVariancePct;
                
                return oStep;
            });
            
            // Sort by task name by default
            aSteps.sort(function (a, b) {
                return a.taskName.localeCompare(b.taskName);
            });
            
            oModel.setProperty("/steps", aSteps);
            oModel.setProperty("/sortField", "taskName");
            oModel.setProperty("/sortDescending", false);
        },

        _detectAnomalies: function (aRuns, oModel) {
            var aAnomalies = [];
            var aSteps = oModel.getProperty("/steps") || [];
            
            // Check for status inconsistencies
            aSteps.forEach(function (oStep) {
                var aStatuses = Object.values(oStep.runs).map(function (r) { return r.status; });
                var aUniqueStatuses = aStatuses.filter(function (v, i, a) { return a.indexOf(v) === i; });
                
                if (aUniqueStatuses.length > 1) {
                    aAnomalies.push({
                        title: "Status inconsistency: " + oStep.taskName,
                        description: "This step has different outcomes across runs: " + aUniqueStatuses.join(", "),
                        icon: "sap-icon://status-error",
                        severity: aUniqueStatuses.includes("error") ? "High" : "Medium"
                    });
                }
            });
            
            // Check for duration anomalies (> 50% variance)
            aSteps.forEach(function (oStep) {
                var aDurations = Object.values(oStep.runs)
                    .filter(function (r) { return r.duration && r.duration > 0; })
                    .map(function (r) { return r.duration; });
                
                if (aDurations.length >= 2) {
                    var fMin = Math.min.apply(null, aDurations);
                    var fMax = Math.max.apply(null, aDurations);
                    
                    if (fMin > 0 && (fMax / fMin) > 2) {
                        aAnomalies.push({
                            title: "Duration variance: " + oStep.taskName,
                            description: "Duration varies significantly: " + fMin.toFixed(1) + " - " + fMax.toFixed(1) + " min",
                            icon: "sap-icon://time-overtime",
                            severity: "Medium"
                        });
                    }
                }
            });
            
            // Check for missing steps
            var iRunCount = aRuns.length;
            aSteps.forEach(function (oStep) {
                var iStepRunCount = Object.keys(oStep.runs).length;
                if (iStepRunCount < iRunCount) {
                    aAnomalies.push({
                        title: "Missing step: " + oStep.taskName,
                        description: "This step is only present in " + iStepRunCount + " of " + iRunCount + " runs",
                        icon: "sap-icon://warning",
                        severity: "Low"
                    });
                }
            });
            
            oModel.setProperty("/anomalies", aAnomalies);
        },

        _buildSummaryCards: function (aRuns) {
            var oContainer = this.byId("summaryCardsContainer");
            oContainer.removeAllItems();
            
            var that = this;
            
            aRuns.forEach(function (oRun, iIndex) {
                var sStatusColor = oRun.status === "success" ? "#107e3e" : 
                                   oRun.status === "error" ? "#bb0000" : "#e9730c";
                var sStatusIcon = oRun.status === "success" ? "sap-icon://sys-enter-2" : 
                                  oRun.status === "error" ? "sap-icon://error" : "sap-icon://pending";
                
                var oCard = new Card({
                    width: "280px",
                    content: new VBox({
                        items: [
                            new HBox({
                                alignItems: "Center",
                                items: [
                                    new Icon({ 
                                        src: sStatusIcon, 
                                        color: sStatusColor,
                                        size: "1.5rem"
                                    }).addStyleClass("sapUiSmallMarginEnd"),
                                    new sap.m.Title({ 
                                        text: "Run " + oRun.runId,
                                        level: "H5"
                                    })
                                ]
                            }).addStyleClass("sapUiSmallMarginBottom"),
                            that._createInfoRow("Task Chain", oRun.taskChain),
                            that._createInfoRow("Status", oRun.status.toUpperCase()),
                            that._createInfoRow("Start", that._formatDateTime(oRun.startTime)),
                            that._createInfoRow("Duration", (oRun.duration || 0).toFixed(1) + " min"),
                            that._createInfoRow("Steps", (oRun.nodes || []).length + " tasks")
                        ]
                    }).addStyleClass("sapUiSmallMargin")
                }).addStyleClass("sapUiSmallMarginEnd sapUiSmallMarginBottom");
                
                oContainer.addItem(oCard);
            });
        },

        _buildComparisonTableColumns: function (aRuns) {
            var oTable = this.byId("stepComparisonTable");
            var that = this;
            
            // Clear all columns
            oTable.removeAllColumns();
            
            // Task Name column (sortable)
            var oNameCol = new Column({
                width: "200px",
                header: new sap.m.Link({ 
                    text: "Task/Step ↕", 
                    press: that.onSortColumn.bind(that)
                }).data("sortField", "taskName")
            });
            oTable.addColumn(oNameCol);
            
            // Type column
            var oTypeCol = new Column({
                width: "80px",
                hAlign: "Center",
                header: new Text({ text: "Type" })
            });
            oTable.addColumn(oTypeCol);
            
            // Avg Duration column (sortable)
            var oAvgCol = new Column({
                width: "100px",
                hAlign: "End",
                header: new sap.m.Link({ 
                    text: "Avg Duration ↕", 
                    press: that.onSortColumn.bind(that)
                }).data("sortField", "avgDuration")
            });
            oTable.addColumn(oAvgCol);
            
            // Variance column (sortable)
            var oVarCol = new Column({
                width: "120px",
                hAlign: "End",
                header: new sap.m.Link({ 
                    text: "Variance ↕", 
                    press: that.onSortColumn.bind(that)
                }).data("sortField", "durationVariance")
            });
            oTable.addColumn(oVarCol);
            
            // Add column for each run
            aRuns.forEach(function (oRun, iIndex) {
                var oColumn = new Column({
                    width: "130px",
                    hAlign: "Center",
                    header: new VBox({
                        items: [
                            new Text({ text: "Run " + oRun.runId }),
                            new ObjectStatus({ 
                                text: oRun.status, 
                                state: oRun.status === "success" ? "Success" : "Error",
                                inverted: true
                            })
                        ]
                    })
                });
                oTable.addColumn(oColumn);
            });
            
            // Rebind items with proper cell factory
            oTable.unbindItems();
            oTable.bindItems({
                path: "compare>/steps",
                factory: this._stepItemFactory.bind(this, aRuns)
            });
        },

        _stepItemFactory: function (aRuns, sId, oContext) {
            var oStep = oContext.getObject();
            
            // Variance state: green if < 20%, yellow if < 50%, red if > 50%
            var sVarianceState = oStep.variancePct < 20 ? "Success" : 
                                 oStep.variancePct < 50 ? "Warning" : "Error";
            
            var aCells = [
                new Text({ text: oStep.taskName }),
                new ObjectStatus({ text: oStep.type, inverted: true, state: "Information" }),
                new Text({ text: (oStep.avgDuration || 0).toFixed(2) + " min" }),
                new VBox({
                    items: [
                        new ObjectStatus({ 
                            text: (oStep.durationVariance || 0).toFixed(2) + " min",
                            state: sVarianceState
                        }),
                        new Text({ 
                            text: "(" + (oStep.variancePct || 0).toFixed(0) + "%)",
                            wrapping: false
                        }).addStyleClass("sapUiTinyText")
                    ]
                })
            ];
            
            // Add cell for each run
            aRuns.forEach(function (oRun, iIndex) {
                var oRunData = oStep.runs["run_" + iIndex];
                
                if (oRunData) {
                    var sState = oRunData.status === "success" ? "Success" : 
                                 oRunData.status === "error" ? "Error" : "Warning";
                    
                    aCells.push(new VBox({
                        items: [
                            new ObjectStatus({ 
                                text: oRunData.status, 
                                state: sState
                            }),
                            new Text({ 
                                text: (oRunData.duration || 0).toFixed(2) + " min",
                                wrapping: false
                            }).addStyleClass("sapUiTinyMarginTop")
                        ]
                    }));
                } else {
                    aCells.push(new Text({ text: "-" }));
                }
            });
            
            return new sap.m.ColumnListItem({ cells: aCells });
        },

        _createInfoRow: function (sLabel, sValue) {
            return new HBox({
                items: [
                    new Label({ text: sLabel + ":", design: "Bold", width: "80px" }),
                    new Text({ text: sValue || "-" })
                ]
            }).addStyleClass("sapUiTinyMarginBottom");
        },

        _formatDateTime: function (sDateTime) {
            if (!sDateTime) return "-";
            try {
                var oDate = new Date(sDateTime);
                return oDate.toLocaleString("en-GB", { 
                    day: "2-digit", month: "short", year: "numeric",
                    hour: "2-digit", minute: "2-digit"
                });
            } catch (e) {
                return sDateTime;
            }
        },

        _getPySrvUrl: function () {
            var sHost = window.location.hostname;
            if (sHost === "localhost" || sHost === "127.0.0.1") {
                return "http://localhost:8080";
            }
            // In production (managed approuter / WorkZone), resolve against the app's
            // HTML5-repo content path so the request goes through xs-app.json routing.
            return sap.ui.require.toUrl("monitoring");
        },

        /**
         * Fetch wrapper for DSP API calls - includes credentials for XSUAA auth in production
         */
        _fetchDsp: function (sUrl) {
            return fetch(sUrl, { credentials: "same-origin" });
        },

        onViewModeChange: function (oEvent) {
            var sKey = oEvent.getParameter("item").getKey();
            this.getView().getModel("compare").setProperty("/viewMode", sKey);
        },

        /**
         * Handle column header press for sorting
         */
        onSortColumn: function (oEvent) {
            var oColumn = oEvent.getSource();
            var sSortField = oColumn.data("sortField");
            
            if (!sSortField) return;
            
            var oModel = this.getView().getModel("compare");
            var sCurrentSort = oModel.getProperty("/sortField");
            var bDescending = oModel.getProperty("/sortDescending");
            
            // Toggle direction if same field, otherwise start ascending
            if (sCurrentSort === sSortField) {
                bDescending = !bDescending;
            } else {
                bDescending = (sSortField === "avgDuration" || sSortField === "durationVariance"); // Duration fields default to desc
            }
            
            oModel.setProperty("/sortField", sSortField);
            oModel.setProperty("/sortDescending", bDescending);
            
            this._sortSteps(sSortField, bDescending);
        },

        /**
         * Sort steps by field
         */
        _sortSteps: function (sField, bDescending) {
            var oModel = this.getView().getModel("compare");
            var aSteps = oModel.getProperty("/steps") || [];
            
            aSteps.sort(function (a, b) {
                var vA = a[sField];
                var vB = b[sField];
                
                // Handle string vs number comparison
                if (typeof vA === "string") {
                    vA = vA.toLowerCase();
                    vB = (vB || "").toLowerCase();
                    return bDescending ? vB.localeCompare(vA) : vA.localeCompare(vB);
                } else {
                    vA = vA || 0;
                    vB = vB || 0;
                    return bDescending ? (vB - vA) : (vA - vB);
                }
            });
            
            oModel.setProperty("/steps", aSteps);
            
            // Rebuild table
            var aRuns = oModel.getProperty("/runs") || [];
            this._buildComparisonTableColumns(aRuns);
        },

        onNavBack: function () {
            var oHistory = sap.ui.core.routing.History.getInstance();
            var sPreviousHash = oHistory.getPreviousHash();

            if (sPreviousHash !== undefined) {
                window.history.go(-1);
            } else {
                this.getOwnerComponent().getRouter().navTo("projectDashboard", {
                    projectId: this._sProjectId
                }, true);
            }
        }
    });
});
