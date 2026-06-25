sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/routing/History",
    "sap/ui/core/Fragment",
    "../model/formatter"
], function (Controller, JSONModel, MessageToast, MessageBox, History, Fragment, formatter) {
    "use strict";

    return Controller.extend("monitoring.controller.ProjectDashboard", {
        
        formatter: formatter,

        onInit: function () {
            var oRouter = this.getOwnerComponent().getRouter();
            oRouter.getRoute("projectDashboard").attachPatternMatched(this._onProjectMatched, this);
        },

        /**
         * Called when the route pattern is matched
         * @param {sap.ui.base.Event} oEvent - The route matched event
         */
        _onProjectMatched: function (oEvent) {
            var sProjectId = oEvent.getParameter("arguments").projectId;
            this._sCurrentProjectId = sProjectId;
            
            // Wait for projects to be loaded before looking up the project
            var oMonitoringModel = this.getOwnerComponent().getModel("monitoring");
            var bLoading = oMonitoringModel.getProperty("/loading");
            
            if (bLoading) {
                // Projects still loading - wait and retry
                var that = this;
                var fnCheckLoaded = function() {
                    if (!oMonitoringModel.getProperty("/loading")) {
                        that._loadProjectData(sProjectId);
                    } else {
                        setTimeout(fnCheckLoaded, 100);
                    }
                };
                setTimeout(fnCheckLoaded, 100);
            } else {
                this._loadProjectData(sProjectId);
            }
        },

        /**
         * Load project data and set to dashboard model
         * @param {string} sProjectId - The project ID
         */
        _loadProjectData: function (sProjectId) {
            var oView = this.getView();
            
            // Get project from monitoring model
            var oMonitoringModel = this.getOwnerComponent().getModel("monitoring");
            var aProjects = oMonitoringModel.getProperty("/projects") || [];
            var oProject = aProjects.find(function(p) { return p.id === sProjectId; });
            
            if (!oProject) {
                MessageBox.error("Project not found");
                this.onNavBack();
                return;
            }

            // Get task chains for this project (stored in project.taskChainsList)
            var aTaskChains = oProject.taskChainsList || [];
            
            // Create initial dashboard model
            var oDashboardModel = new JSONModel({
                projectId: sProjectId,
                projectName: oProject.name,
                projectDescription: oProject.description || "",
                totalTaskChains: aTaskChains.length,
                successRate: 100,
                successRateTrend: 0,
                errorsLast24h: 0,
                avgDurationP95: 0,
                activeAlerts: 0,
                avgStepsExecuted: 0,
                avgStepsFailed: 0,
                executionChartData: [],
                topFailingTasks: [],
                recentExecutions: [],
                allExecutions: [],
                filteredExecutions: [],
                taskChains: aTaskChains,
                loading: true,
                selectedRunsCount: 0,
                selectedRuns: [],
                selectedChainsCount: 0,
                selectedChains: []
            });
            
            oView.setModel(oDashboardModel, "dashboard");
            
            // Update page title
            var oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            this.byId("dashboardTitle").setText(
                oResourceBundle.getText("dashboard.title", [oProject.name])
            );

            // Load executions from DSP for each task chain
            this._loadExecutionsFromDSP(aTaskChains, oDashboardModel);
        },

        /**
         * Load task chain executions from DSP API
         */
        _loadExecutionsFromDSP: function (aTaskChains, oDashboardModel) {
            if (!aTaskChains || aTaskChains.length === 0) {
                oDashboardModel.setProperty("/loading", false);
                return;
            }

            this.getOwnerComponent()._setBusy(true);

            // Determine API base URL
            var sBaseUrl = this._getPySrvUrl();
            var that = this;

            // Build request body with all task chains to monitor
            // Use limit=800 to support 2+ years of daily executions
            var aPromises = aTaskChains.map(function(tc) {
                var sUrl = sBaseUrl + "/v1/dsp/taskchain-runs?spaceId=" + encodeURIComponent(tc.spaceId || "") + 
                           "&taskchain=" + encodeURIComponent(tc.name || tc.id) + 
                           "&limit=800";
                return that._fetchDsp(sUrl)
                    .then(function(response) {
                        if (!response.ok) {
                            return response.text().then(function(body) {
                                console.error("DSP fetch failed:", response.status, body, sUrl);
                                return { success: false, runs: [] };
                            });
                        }
                        return response.json();
                    })
                    .catch(function(err) {
                        console.error("DSP fetch error:", err, sUrl);
                        return { success: false, runs: [] };
                    });
            });

            Promise.all(aPromises).then(function(aResults) {
                // Merge all runs
                var aAllRuns = [];
                aResults.forEach(function(result) {
                    if (result.success && result.runs) {
                        aAllRuns = aAllRuns.concat(result.runs);
                    }
                });

                // Sort by start time descending
                aAllRuns.sort(function(a, b) {
                    return new Date(b.startTime) - new Date(a.startTime);
                });

                // Load node counts for recent runs (only first 10 for table display, faster loading)
                var aRecentRuns = aAllRuns.slice(0, 10);
                var aNodePromises = aRecentRuns.map(function(run) {
                    return that._fetchDsp(sBaseUrl + "/v1/dsp/taskchain-run-nodes?chainTaskLogId=" + encodeURIComponent(run.runId))
                        .then(function(r) { return r.json(); })
                        .catch(function() { return { success: false, nodes: [] }; });
                });

                Promise.all(aNodePromises).then(function(aNodeResults) {
                    // Enhance runs with step counts
                    var iTotalSteps = 0;
                    var iTotalFailedSteps = 0;
                    var iRunsWithSteps = 0;

                    aRecentRuns.forEach(function(run, idx) {
                        var nodeResult = aNodeResults[idx];
                        if (nodeResult.success && nodeResult.nodes) {
                            var aNodes = nodeResult.nodes;
                            run.stepsCompleted = aNodes.filter(function(n) { return n.status === "success"; }).length;
                            run.stepsRunning = aNodes.filter(function(n) { return n.status === "running" || n.status === "pending"; }).length;
                            run.stepsFailed = aNodes.filter(function(n) { return n.status === "error"; }).length;
                            run.totalSteps = aNodes.length;
                            
                            iTotalSteps += aNodes.length;
                            iTotalFailedSteps += run.stepsFailed;
                            iRunsWithSteps++;
                        } else {
                            run.stepsCompleted = 0;
                            run.stepsRunning = 0;
                            run.stepsFailed = 0;
                            run.totalSteps = 0;
                        }

                        // Calculate duration display - for running, show elapsed time
                        if (run.status === "running" && run.startTime) {
                            var now = new Date();
                            var start = new Date(run.startTime);
                            var elapsedMin = ((now - start) / 60000).toFixed(1);
                            run.durationDisplay = elapsedMin + " min (running)";
                        } else if (run.duration && typeof run.duration === "number") {
                            run.durationDisplay = run.duration.toFixed(1) + " min";
                        } else {
                            run.durationDisplay = "-";
                        }
                    });

                    // For older runs without node data, leave undefined for lazy loading
                    aAllRuns.slice(10).forEach(function(run) {
                        // Don't set step counts - leave undefined so lazy loading picks them up
                        if (run.duration && typeof run.duration === "number") {
                            run.durationDisplay = run.duration.toFixed(1) + " min";
                        } else {
                            run.durationDisplay = "-";
                        }
                    });

                    // Calculate KPIs
                    var iSuccessCount = aAllRuns.filter(function(e) { return e.status === "success"; }).length;
                    var iTotalCount = aAllRuns.length;
                    var fSuccessRate = iTotalCount > 0 ? (iSuccessCount / iTotalCount * 100) : 100;

                    var now = new Date();
                    // Count runs with errors in last 24h: either status=error OR has failed steps (even if still running)
                    var iErrors24h = aRecentRuns.filter(function(e) {
                        var execTime = new Date(e.startTime);
                        var isRecent = (now - execTime) < 24 * 60 * 60 * 1000;
                        var hasError = e.status === "error" || (e.stepsFailed && e.stepsFailed > 0);
                        return isRecent && hasError;
                    }).length;

                    // Calculate Avg Duration (P95) and Std Dev
                    var aDurations = aAllRuns
                        .filter(function(e) { return e.duration && typeof e.duration === "number" && e.duration > 0; })
                        .map(function(e) { return e.duration; })
                        .sort(function(a, b) { return a - b; });
                    
                    var fAvgDurationP95 = 0;
                    var fDurationStdDev = 0;
                    if (aDurations.length > 0) {
                        var iP95Index = Math.floor(aDurations.length * 0.95);
                        iP95Index = Math.min(iP95Index, aDurations.length - 1);
                        fAvgDurationP95 = aDurations[iP95Index];
                        
                        // Calculate standard deviation
                        var fAvgDuration = aDurations.reduce(function(a, b) { return a + b; }, 0) / aDurations.length;
                        if (aDurations.length > 1) {
                            var fVariance = aDurations.reduce(function(sum, val) {
                                return sum + Math.pow(val - fAvgDuration, 2);
                            }, 0) / aDurations.length;
                            fDurationStdDev = Math.sqrt(fVariance);
                        }
                    }

                    // Calculate avg steps KPIs
                    var fAvgSteps = iRunsWithSteps > 0 ? (iTotalSteps / iRunsWithSteps) : 0;
                    var fAvgFailedSteps = iRunsWithSteps > 0 ? (iTotalFailedSteps / iRunsWithSteps) : 0;

                    // Update model
                    oDashboardModel.setProperty("/allExecutions", aAllRuns);
                    oDashboardModel.setProperty("/filteredExecutions", aAllRuns);
                    oDashboardModel.setProperty("/recentExecutions", aAllRuns);
                    oDashboardModel.setProperty("/totalExecutions", iTotalCount);
                    oDashboardModel.setProperty("/successRate", fSuccessRate.toFixed(1));
                    oDashboardModel.setProperty("/errorsLast24h", iErrors24h);
                    oDashboardModel.setProperty("/avgDurationP95", fAvgDurationP95.toFixed(1));
                    oDashboardModel.setProperty("/durationStdDev", fDurationStdDev.toFixed(1));
                    oDashboardModel.setProperty("/avgStepsExecuted", fAvgSteps.toFixed(1));
                    oDashboardModel.setProperty("/avgStepsFailed", fAvgFailedSteps.toFixed(2));
                    oDashboardModel.setProperty("/executionChartData", that._generateChartDataFromExecutions(aAllRuns, "related"));
                    oDashboardModel.setProperty("/topFailingTasks", that._getTopFailingTasks(aAllRuns));
                    oDashboardModel.setProperty("/loading", false);
                    that.getOwnerComponent()._setBusy(false);

                    // Update project in monitoring model with real data
                    that._updateProjectStats(fSuccessRate, iErrors24h, fAvgDurationP95, aTaskChains.length);
                }).catch(function(error) {
                    console.error("Error loading node details:", error);
                    oDashboardModel.setProperty("/loading", false);
                    that.getOwnerComponent()._setBusy(false);
                });
            }.bind(this)).catch(function(error) {
                console.error("Error loading executions:", error);
                oDashboardModel.setProperty("/loading", false);
                that.getOwnerComponent()._setBusy(false);
            });
        },

        /**
         * Get py-srv URL - localhost in dev, relative path in production
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
         * Update project statistics in monitoring model
         * @param {number} fSuccessRate - Success rate percentage
         * @param {number} iErrors24h - Errors in last 24 hours
         * @param {number} fAvgDurationP95 - Average duration P95
         * @param {number} iTaskChains - Number of task chains
         */
        _updateProjectStats: function (fSuccessRate, iErrors24h, fAvgDurationP95, iTaskChains) {
            var oMonitoringModel = this.getOwnerComponent().getModel("monitoring");
            var sProjectId = this.getView().getModel("dashboard").getProperty("/projectId");
            var aProjects = oMonitoringModel.getProperty("/projects") || [];
            
            var iProjectIndex = aProjects.findIndex(function(p) { return p.id === sProjectId; });
            if (iProjectIndex !== -1) {
                // Update project with real stats
                oMonitoringModel.setProperty("/projects/" + iProjectIndex + "/successRate", parseFloat(fSuccessRate.toFixed(1)));
                oMonitoringModel.setProperty("/projects/" + iProjectIndex + "/errorsLast24h", iErrors24h);
                oMonitoringModel.setProperty("/projects/" + iProjectIndex + "/avgDurationP95", parseFloat(fAvgDurationP95.toFixed(1)));
                oMonitoringModel.setProperty("/projects/" + iProjectIndex + "/taskChains", iTaskChains);
                
                // Persist to localStorage
                this.getOwnerComponent().saveProjects();
            }
        },

        /**
         * Generate chart data from actual executions
         * @param {Array} aExecutions - All executions
         * @param {string} sFilterMode - Filter mode: 'related', 'lastRuns', 'errors'
         * @param {string} sTimePeriod - Time period: '24h', '7d', '30d', '365d', 'all'
         */
        _generateChartDataFromExecutions: function (aExecutions, sFilterMode, sTimePeriod) {
            if (!aExecutions || aExecutions.length === 0) {
                return [];
            }
            
            sTimePeriod = sTimePeriod || "24h";
            var now = new Date();
            var cutoffTime;
            
            // Calculate cutoff based on time period
            switch(sTimePeriod) {
                case "7d":
                    cutoffTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    break;
                case "30d":
                    cutoffTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                    break;
                case "365d":
                    cutoffTime = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                    break;
                case "all":
                    cutoffTime = new Date(0); // Beginning of time
                    break;
                default: // 24h
                    cutoffTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            }
            
            // Filter by time period
            var aFiltered = aExecutions.filter(function(exec) {
                var execTime = new Date(exec.startTime || exec.timestamp);
                return execTime >= cutoffTime;
            });
            
            // Apply additional filter based on mode
            if (sFilterMode === "errors") {
                aFiltered = aFiltered.filter(function(exec) {
                    return exec.status === "error";
                });
            }
            
            // Group data based on time period
            var oGroupedData = {};
            var sGroupFormat;
            
            aFiltered.forEach(function(exec) {
                var execDate = new Date(exec.startTime || exec.timestamp);
                var sKey;
                
                if (sTimePeriod === "24h") {
                    // Group by hour
                    var hour = execDate.getHours();
                    sKey = (hour < 10 ? "0" : "") + hour + ":00";
                } else if (sTimePeriod === "7d") {
                    // Group by day of week
                    var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
                    sKey = days[execDate.getDay()] + " " + execDate.getDate();
                } else if (sTimePeriod === "30d") {
                    // Group by day
                    sKey = (execDate.getMonth() + 1) + "/" + execDate.getDate();
                } else if (sTimePeriod === "365d") {
                    // Group by month
                    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                    sKey = months[execDate.getMonth()] + " " + execDate.getFullYear();
                } else {
                    // All time - group by year
                    sKey = execDate.getFullYear().toString();
                }
                
                if (!oGroupedData[sKey]) {
                    oGroupedData[sKey] = { successes: 0, errors: 0, sortKey: execDate.getTime() };
                }
                if (exec.status === "success") {
                    oGroupedData[sKey].successes++;
                } else {
                    oGroupedData[sKey].errors++;
                }
            });
            
            // Sort and return
            var aKeys = Object.keys(oGroupedData);
            aKeys.sort(function(a, b) {
                return oGroupedData[a].sortKey - oGroupedData[b].sortKey;
            });
            
            return aKeys.map(function(key) {
                return {
                    time: key,
                    successes: oGroupedData[key].successes,
                    errors: oGroupedData[key].errors
                };
            });
        },

        /**
         * Get top failing tasks from executions
         */
        _getTopFailingTasks: function (aExecutions) {
            if (!aExecutions || aExecutions.length === 0) {
                return [];
            }
            
            var oTaskFailures = {};
            aExecutions.filter(function(e) { return e.status === "error"; })
                .forEach(function(exec) {
                    var name = exec.taskChain || "Unknown";
                    if (!oTaskFailures[name]) {
                        oTaskFailures[name] = { failures: 0, totalDuration: 0, count: 0 };
                    }
                    oTaskFailures[name].failures++;
                    // duration is now numeric (in minutes) or null
                    var duration = parseFloat(exec.duration);
                    if (!isNaN(duration)) {
                        oTaskFailures[name].totalDuration += duration;
                        oTaskFailures[name].count++;
                    }
                });
            
            return Object.keys(oTaskFailures)
                .map(function(name) {
                    var data = oTaskFailures[name];
                    var avgLatency = "N/A";
                    if (data.count > 0) {
                        avgLatency = (data.totalDuration / data.count).toFixed(1) + " min";
                    }
                    return {
                        name: name,
                        failures: data.failures,
                        avgLatency: avgLatency
                    };
                })
                .sort(function(a, b) { return b.failures - a.failures; })
                .slice(0, 5);
        },

        /**
         * Open dialog to add task chains from DSP
         */
        onAddTaskChain: function () {
            console.log("onAddTaskChain called");
            var oView = this.getView();
            
            // Initialize available chains model (will be populated from DSP API)
            if (!this._oAvailableChainsModel) {
                this._oAvailableChainsModel = new JSONModel({
                    loading: true,
                    chains: [],
                    selectedChains: []
                });
            }

            if (!this._pAddChainDialog) {
                console.log("Loading AddTaskChainDialog fragment");
                this._pAddChainDialog = Fragment.load({
                    id: oView.getId(),
                    name: "monitoring.view.fragments.AddTaskChainDialog",
                    controller: this
                }).then(function (oDialog) {
                    console.log("Fragment loaded successfully");
                    oView.addDependent(oDialog);
                    oDialog.setModel(this._oAvailableChainsModel, "availableChains");
                    return oDialog;
                }.bind(this)).catch(function(err) {
                    console.error("Error loading fragment:", err);
                });
            }

            this._pAddChainDialog.then(function (oDialog) {
                console.log("Opening dialog");
                // Load available task chains from DSP
                this._loadAvailableTaskChains();
                oDialog.open();
            }.bind(this));
        },

        /**
         * Load available task chains from DSP via OData service
         */
        _loadAvailableTaskChains: function () {
            this._oAvailableChainsModel.setProperty("/loading", true);
            this._oAvailableChainsModel.setProperty("/chains", []);
            this._oAvailableChainsModel.setProperty("/chainsFiltered", []);
            this._oAvailableChainsModel.setProperty("/selectedChains", []);
            this._oAvailableChainsModel.setProperty("/searchSpace", "");
            this._oAvailableChainsModel.setProperty("/searchChain", "");
            
            // Also clear list selection if list exists
            var oList = this.byId("availableChainsList");
            if (oList) {
                oList.removeSelections(true);
            }
            
            // Use the existing OData Taskchain entity (srv/domains/taskchains.cds)
            // Use relative URL so it works correctly through the Launchpad approuter
            var sServiceUrl = this.getOwnerComponent().getManifestObject().resolveUri("odata/v4/services/");
            var sApiUrl = sServiceUrl + "Taskchain";
            
            fetch(sApiUrl, { credentials: "same-origin" })
                .then(function(response) {
                    if (!response.ok) {
                        throw new Error("Failed to fetch task chains: " + response.status);
                    }
                    return response.json();
                })
                .then(function(data) {
                    // OData response has 'value' array
                    var oDashboardModel = this.getView().getModel("dashboard");
                    var aCurrentChains = oDashboardModel ? (oDashboardModel.getProperty("/taskChains") || []) : [];
                    var aCurrentKeys = aCurrentChains.map(function(c) { return c.spaceId + "|" + c.name; });

                    var aChains = (data.value || []).filter(function(chain) {
                        return aCurrentKeys.indexOf(chain.spaceId + "|" + chain.name) < 0;
                    });
                    this._oAvailableChainsModel.setProperty("/chains", aChains);
                    this._oAvailableChainsModel.setProperty("/chainsFiltered", aChains);
                    this._oAvailableChainsModel.setProperty("/loading", false);
                }.bind(this))
                .catch(function(error) {
                    console.error("Error loading task chains:", error);
                    this._oAvailableChainsModel.setProperty("/loading", false);
                    MessageToast.show("Could not load task chains from DSP. Check API connection.");
                }.bind(this));
        },

        /**
         * Filter chains based on search input
         */
        onChainSearchChange: function (oEvent) {
            var sNewValue = oEvent.getParameter("newValue") || "";
            var oSource = oEvent.getSource();
            var oSpaceInput = this.byId("searchSpaceInput");
            var oChainInput = this.byId("searchChainInput");

            var sSpaceFilter = (oSpaceInput === oSource ? sNewValue : (oSpaceInput ? oSpaceInput.getValue() : "")).toLowerCase().trim();
            var sChainFilter = (oChainInput === oSource ? sNewValue : (oChainInput ? oChainInput.getValue() : "")).toLowerCase().trim();

            // Keep model in sync
            this._oAvailableChainsModel.setProperty("/searchSpace", oSpaceInput ? oSpaceInput.getValue() : "");
            this._oAvailableChainsModel.setProperty("/searchChain", oChainInput ? oChainInput.getValue() : "");

            var aAllChains = this._oAvailableChainsModel.getProperty("/chains") || [];

            var aFiltered = aAllChains.filter(function(chain) {
                // Space filter: matches only spaceId (e.g. "IFP")
                var bSpaceMatch = !sSpaceFilter ||
                    (chain.spaceId || "").toLowerCase().indexOf(sSpaceFilter) >= 0;
                // Chain filter: matches business name (bold title) and technical name
                var bChainMatch = !sChainFilter ||
                    (chain.businessName || "").toLowerCase().indexOf(sChainFilter) >= 0 ||
                    (chain.name || "").toLowerCase().indexOf(sChainFilter) >= 0;
                return bSpaceMatch && bChainMatch;
            });

            this._oAvailableChainsModel.setProperty("/chainsFiltered", aFiltered);
        },

        /**
         * Handle task chain selection in dialog
         */
        onChainSelectionChange: function (oEvent) {
            var aSelectedItems = oEvent.getParameter("listItems") || oEvent.getSource().getSelectedItems();
            console.log("onChainSelectionChange - selected items:", aSelectedItems.length);
            var aSelectedChains = aSelectedItems.map(function(item) {
                var oCtx = item.getBindingContext("availableChains");
                console.log("Item binding context:", oCtx);
                return oCtx ? oCtx.getObject() : null;
            }).filter(Boolean);
            console.log("Selected chains:", aSelectedChains);
            this._oAvailableChainsModel.setProperty("/selectedChains", aSelectedChains);
        },

        /**
         * Confirm adding selected task chains
         */
        onAddChainConfirm: function () {
            console.log("onAddChainConfirm called");
            var that = this;
            
            // Get selected items directly from the list
            var oList = this.byId("availableChainsList");
            var aSelectedItems = oList ? oList.getSelectedItems() : [];
            console.log("Selected items from list:", aSelectedItems.length);
            
            var aSelectedChains = aSelectedItems.map(function(item) {
                var oCtx = item.getBindingContext("availableChains");
                return oCtx ? oCtx.getObject() : null;
            }).filter(Boolean);
            
            console.log("Selected chains:", aSelectedChains);
            
            if (aSelectedChains.length === 0) {
                MessageToast.show("Please select at least one task chain");
                return;
            }

            console.log("Adding chains to project:", this._sCurrentProjectId);
            // Add chains via OData
            this.getOwnerComponent()._setBusy(true);

            var aPromises = aSelectedChains.map(function(chain) {
                return that.getOwnerComponent().addTaskChain(that._sCurrentProjectId, {
                    name: chain.name,
                    spaceId: chain.spaceId,
                    description: chain.description || "",
                    version: chain.version || "1.0"
                });
            });

            Promise.all(aPromises).then(function() {
                that._loadProjectData(that._sCurrentProjectId);
                MessageToast.show(aSelectedChains.length + " task chain(s) added");
            }).catch(function(oError) {
                console.error("[Dashboard] Error adding chains:", oError);
                MessageBox.error("Error adding task chains: " + oError.message);
            });

            this._closeAddChainDialog();
        },

        /**
         * Cancel adding task chains
         */
        onAddChainCancel: function () {
            this._closeAddChainDialog();
        },

        /**
         * Close the add chain dialog
         */
        _closeAddChainDialog: function () {
            this._pAddChainDialog.then(function (oDialog) {
                oDialog.close();
            });
        },

        /**
         * Remove a task chain from the project
         */
        onRemoveTaskChain: function (oEvent) {
            var oBindingContext = oEvent.getSource().getBindingContext("dashboard");
            var sChainName = oBindingContext.getProperty("name");
            var sSpaceId = oBindingContext.getProperty("spaceId");
            var oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            MessageBox.confirm(
                oResourceBundle.getText("dashboard.removeChainConfirm", [sChainName]),
                {
                    title: oResourceBundle.getText("dashboard.removeChainTitle"),
                    onClose: function (oAction) {
                        if (oAction === MessageBox.Action.OK) {
                            this._removeTaskChain(sChainName, sSpaceId);
                        }
                    }.bind(this)
                }
            );
        },

        /**
         * Perform task chain removal via OData
         */
        _removeTaskChain: function (sChainName, sSpaceId) {
            var that = this;
            var oMonitoringModel = this.getOwnerComponent().getModel("monitoring");
            var aProjects = oMonitoringModel.getProperty("/projects") || [];
            var oProject = aProjects.find(function(p) { return p.id === that._sCurrentProjectId; });

            if (oProject && oProject.taskChainsList) {
                // Find the task chain ID to delete
                var oChain = oProject.taskChainsList.find(function(c) {
                    return c.name === sChainName && c.spaceId === sSpaceId;
                });

                if (oChain && oChain.id) {
                    this.getOwnerComponent()._setBusy(true);
                    this.getOwnerComponent().removeTaskChain(oChain.id).then(function() {
                        that._loadProjectData(that._sCurrentProjectId);
                        MessageToast.show("Task chain removed");
                    }).catch(function(oError) {
                        MessageBox.error("Error removing task chain: " + oError.message);
                    });
                }
            }
        },

        /**
         * Refresh dashboard data
         */
        onRefresh: function () {
            this._loadProjectData(this._sCurrentProjectId);
        },

        /**
         * Navigate back to project list
         */
        onNavBack: function () {
            var oHistory = History.getInstance();
            var sPreviousHash = oHistory.getPreviousHash();

            if (sPreviousHash !== undefined) {
                window.history.go(-1);
            } else {
                this.getOwnerComponent().getRouter().navTo("projectList", {}, true);
            }
        },

        /**
         * Handle chart filter change (Related/Last Runs/Errors)
         * @param {sap.ui.base.Event} oEvent - The selection change event
         */
        onChartFilterChange: function (oEvent) {
            var sKey = oEvent.getParameter("item").getKey();
            this._updateChartData(sKey, null);
        },
        
        /**
         * Handle time period change
         * @param {sap.ui.base.Event} oEvent - The change event
         */
        onTimePeriodChange: function (oEvent) {
            var sTimePeriod = oEvent.getParameter("selectedItem").getKey();
            this._updateChartData(null, sTimePeriod);
        },
        
        /**
         * Update chart data based on current filters
         * @param {string} sFilterMode - Optional new filter mode
         * @param {string} sTimePeriod - Optional new time period
         */
        _updateChartData: function (sFilterMode, sTimePeriod) {
            var oDashboardModel = this.getView().getModel("dashboard");
            var aAllExecutions = oDashboardModel.getProperty("/allExecutions") || [];
            var oChart = this.byId("executionChart");
            
            // Get current values if not provided
            if (!sFilterMode) {
                sFilterMode = this.byId("chartFilter").getSelectedKey();
            }
            if (!sTimePeriod) {
                sTimePeriod = this.byId("timePeriodSelect").getSelectedKey();
            }
            
            // Switch chart type based on filter mode
            if (sFilterMode === "durationTrend") {
                // Line chart for duration trend
                this._configureChartForDuration(oChart);
                var aDurationData = this._generateDurationChartData(aAllExecutions, sTimePeriod);
                oDashboardModel.setProperty("/executionChartData", aDurationData);
            } else {
                // Stacked column for successes/errors
                this._configureChartForExecutions(oChart);
                var aChartData = this._generateChartDataFromExecutions(aAllExecutions, sFilterMode, sTimePeriod);
                oDashboardModel.setProperty("/executionChartData", aChartData);
            }
        },
        
        /**
         * Configure chart for duration line chart
         */
        _configureChartForDuration: function (oChart) {
            oChart.setVizType("line");
            oChart.setVizProperties({
                plotArea: {
                    colorPalette: ["#0854a0", "#107e3e", "#e9730c", "#e9730c"],
                    dataLabel: { visible: false },
                    marker: { visible: true, size: 6 },
                    linePattern: { pattern: ["solid", "dash", "dash", "dash"] }
                },
                legend: { visible: true, position: "bottom" },
                title: { visible: false },
                categoryAxis: { title: { visible: true, text: "Run" } },
                valueAxis: { title: { visible: true, text: "Duration (min)" } }
            });
            
            // Update feeds for duration with avg and stddev
            oChart.removeAllFeeds();
            oChart.addFeed(new sap.viz.ui5.controls.common.feeds.FeedItem({
                uid: "categoryAxis",
                type: "Dimension",
                values: ["Time"]
            }));
            oChart.addFeed(new sap.viz.ui5.controls.common.feeds.FeedItem({
                uid: "valueAxis",
                type: "Measure",
                values: ["Duration", "Avg", "+1 StdDev", "-1 StdDev"]
            }));
        },
        
        /**
         * Configure chart for executions stacked column
         */
        _configureChartForExecutions: function (oChart) {
            oChart.setVizType("stacked_column");
            oChart.setVizProperties({
                plotArea: {
                    colorPalette: ["#107e3e", "#bb0000"],
                    dataLabel: { visible: false }
                },
                legend: { visible: true, position: "bottom" },
                title: { visible: false },
                categoryAxis: { title: { visible: true, text: "Time" } },
                valueAxis: { title: { visible: true, text: "Executions" } }
            });
            
            // Update feeds for executions
            oChart.removeAllFeeds();
            oChart.addFeed(new sap.viz.ui5.controls.common.feeds.FeedItem({
                uid: "categoryAxis",
                type: "Dimension",
                values: ["Time"]
            }));
            oChart.addFeed(new sap.viz.ui5.controls.common.feeds.FeedItem({
                uid: "valueAxis",
                type: "Measure",
                values: ["Successes", "Errors"]
            }));
        },
        
        /**
         * Generate duration chart data for last runs
         */
        _generateDurationChartData: function (aExecutions, sTimePeriod) {
            if (!aExecutions || aExecutions.length === 0) {
                return [];
            }
            
            sTimePeriod = sTimePeriod || "24h";
            var now = new Date();
            var cutoffTime;
            
            switch(sTimePeriod) {
                case "7d": cutoffTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
                case "30d": cutoffTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
                case "365d": cutoffTime = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); break;
                case "all": cutoffTime = new Date(0); break;
                default: cutoffTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            }
            
            // Filter by time and only completed runs with duration
            var aFiltered = aExecutions.filter(function(exec) {
                var execTime = new Date(exec.startTime);
                return execTime >= cutoffTime && exec.duration && exec.duration > 0;
            });
            
            // Sort by time ascending
            aFiltered.sort(function(a, b) {
                return new Date(a.startTime) - new Date(b.startTime);
            });
            
            // Limit to last 50 runs for readability
            if (aFiltered.length > 50) {
                aFiltered = aFiltered.slice(-50);
            }
            
            // Calculate average and standard deviation
            var aDurations = aFiltered.map(function(e) { return e.duration; });
            var fAvg = 0;
            var fStdDev = 0;
            
            if (aDurations.length > 0) {
                fAvg = aDurations.reduce(function(a, b) { return a + b; }, 0) / aDurations.length;
                
                if (aDurations.length > 1) {
                    var fVariance = aDurations.reduce(function(sum, val) {
                        return sum + Math.pow(val - fAvg, 2);
                    }, 0) / aDurations.length;
                    fStdDev = Math.sqrt(fVariance);
                }
            }
            
            var fStdHigh = fAvg + fStdDev;
            var fStdLow = Math.max(0, fAvg - fStdDev);
            
            // Generate data points
            return aFiltered.map(function(exec, idx) {
                var execDate = new Date(exec.startTime);
                var sLabel;
                if (sTimePeriod === "24h") {
                    sLabel = execDate.getHours() + ":" + (execDate.getMinutes() < 10 ? "0" : "") + execDate.getMinutes();
                } else {
                    sLabel = (execDate.getMonth() + 1) + "/" + execDate.getDate() + " " + execDate.getHours() + ":" + (execDate.getMinutes() < 10 ? "0" : "") + execDate.getMinutes();
                }
                return {
                    time: sLabel,
                    duration: parseFloat(exec.duration.toFixed(1)),
                    avg: parseFloat(fAvg.toFixed(1)),
                    stdHigh: parseFloat(fStdHigh.toFixed(1)),
                    stdLow: parseFloat(fStdLow.toFixed(1)),
                    successes: 0,
                    errors: 0
                };
            });
        },

        /**
         * Navigate to task chain detail when clicked
         * @param {sap.ui.base.Event} oEvent - The press event
         */
        onTaskChainPress: function (oEvent) {
            var oBindingContext = oEvent.getSource().getBindingContext("dashboard");
            var sChainId = oBindingContext.getProperty("id");
            var sProjectId = this.getView().getModel("dashboard").getProperty("/projectId");
            
            this.getOwnerComponent().getRouter().navTo("taskChainDetail", {
                projectId: sProjectId,
                chainId: sChainId
            });
        },

        /**
         * Navigate to run inspector when a run ID is clicked
         * @param {sap.ui.base.Event} oEvent - The press event
         */
        onRunIdPress: function (oEvent) {
            var oBindingContext = oEvent.getSource().getBindingContext("dashboard");
            var sRunId = oBindingContext.getProperty("runId");
            var sChainName = oBindingContext.getProperty("taskChain");
            var sProjectId = this.getView().getModel("dashboard").getProperty("/projectId");
            
            this.getOwnerComponent().getRouter().navTo("runInspector", {
                projectId: sProjectId,
                chainId: encodeURIComponent(sChainName),
                runId: sRunId
            });
        },

        /**
         * Handle task press in failing tasks table
         * @param {sap.ui.base.Event} oEvent - The press event
         */
        onTaskPress: function (oEvent) {
            var oBindingContext = oEvent.getSource().getBindingContext("dashboard");
            var sTaskName = oBindingContext.getProperty("name");
            var sProjectId = this.getView().getModel("dashboard").getProperty("/projectId");
            
            // Navigate to task chain detail view
            this.getOwnerComponent().getRouter().navTo("taskChainDetail", {
                projectId: sProjectId,
                chainId: encodeURIComponent(sTaskName)
            });
        },

        /**
         * Handle execution row press
         * @param {sap.ui.base.Event} oEvent - The press event
         */
        onExecutionPress: function (oEvent) {
            var oBindingContext = oEvent.getSource().getBindingContext("dashboard");
            var sRunId = oBindingContext.getProperty("runId");
            this.onRunIdPress(oEvent);
        },

        /**
         * Handle chain selection change for filtering
         * @param {sap.ui.base.Event} oEvent - The selection change event
         */
        onChainSelectionChange: function (oEvent) {
            var oList = this.byId("taskChainsList");
            var aSelectedItems = oList.getSelectedItems();
            var oDashboardModel = this.getView().getModel("dashboard");
            
            var aSelectedChains = aSelectedItems.map(function(oItem) {
                return oItem.getBindingContext("dashboard").getObject();
            });
            
            oDashboardModel.setProperty("/selectedChainsCount", aSelectedChains.length);
            oDashboardModel.setProperty("/selectedChains", aSelectedChains);
            
            // Apply filter to executions
            this._applyChainFilter(aSelectedChains);
        },

        /**
         * Clear chain filter
         */
        onClearChainFilter: function () {
            var oList = this.byId("taskChainsList");
            oList.removeSelections(true);
            
            var oDashboardModel = this.getView().getModel("dashboard");
            oDashboardModel.setProperty("/selectedChainsCount", 0);
            oDashboardModel.setProperty("/selectedChains", []);
            
            // Reset to all executions
            var aAllExecutions = oDashboardModel.getProperty("/allExecutions") || [];
            oDashboardModel.setProperty("/recentExecutions", aAllExecutions);
            oDashboardModel.setProperty("/filteredExecutions", aAllExecutions);
            
            // Update chart
            var sFilterMode = this.byId("chartFilter").getSelectedKey() || "related";
            var sTimePeriod = this.byId("timePeriodSelect").getSelectedKey() || "24h";
            oDashboardModel.setProperty("/executionChartData", this._generateChartDataFromExecutions(aAllExecutions, sFilterMode, sTimePeriod));
        },

        /**
         * Apply chain filter to executions
         */
        _applyChainFilter: function (aSelectedChains) {
            var oDashboardModel = this.getView().getModel("dashboard");
            var aAllExecutions = oDashboardModel.getProperty("/allExecutions") || [];
            
            var aFiltered;
            if (aSelectedChains.length === 0) {
                aFiltered = aAllExecutions;
            } else {
                var aChainNames = aSelectedChains.map(function(c) { return c.name; });
                aFiltered = aAllExecutions.filter(function(exec) {
                    return aChainNames.indexOf(exec.taskChain) >= 0;
                });
            }
            
            oDashboardModel.setProperty("/recentExecutions", aFiltered);
            oDashboardModel.setProperty("/filteredExecutions", aFiltered);
            
            // Update chart with filtered data
            var sFilterMode = this.byId("chartFilter").getSelectedKey() || "related";
            var sTimePeriod = this.byId("timePeriodSelect").getSelectedKey() || "24h";
            oDashboardModel.setProperty("/executionChartData", this._generateChartDataFromExecutions(aFiltered, sFilterMode, sTimePeriod));
            
            // Update KPIs for filtered data
            this._updateKPIsForFilteredData(aFiltered);
        },

        /**
         * Update KPIs based on filtered executions
         */
        _updateKPIsForFilteredData: function (aExecutions) {
            var oDashboardModel = this.getView().getModel("dashboard");
            
            var iSuccessCount = aExecutions.filter(function(e) { return e.status === "success"; }).length;
            var iTotalCount = aExecutions.length;
            var fSuccessRate = iTotalCount > 0 ? (iSuccessCount / iTotalCount * 100) : 100;
            
            var now = new Date();
            var iErrors24h = aExecutions.filter(function(e) {
                var execTime = new Date(e.startTime);
                return e.status === "error" && (now - execTime) < 24 * 60 * 60 * 1000;
            }).length;
            
            oDashboardModel.setProperty("/successRate", fSuccessRate.toFixed(1));
            oDashboardModel.setProperty("/errorsLast24h", iErrors24h);
            oDashboardModel.setProperty("/totalExecutions", iTotalCount);
            oDashboardModel.setProperty("/topFailingTasks", this._getTopFailingTasks(aExecutions));
        },

        /**
         * Handle execution selection change for comparison
         * @param {sap.ui.base.Event} oEvent - The selection change event
         */
        onExecutionSelectionChange: function (oEvent) {
            var oTable = this.byId("recentExecutionsTable");
            var aSelectedItems = oTable.getSelectedItems();
            var oDashboardModel = this.getView().getModel("dashboard");
            
            var aSelectedRuns = aSelectedItems.map(function(oItem) {
                return oItem.getBindingContext("dashboard").getObject();
            });
            
            oDashboardModel.setProperty("/selectedRunsCount", aSelectedRuns.length);
            oDashboardModel.setProperty("/selectedRuns", aSelectedRuns);
        },

        /**
         * Navigate to comparison page for selected runs
         */
        onCompareRuns: function () {
            var oDashboardModel = this.getView().getModel("dashboard");
            var aSelectedRuns = oDashboardModel.getProperty("/selectedRuns") || [];
            
            if (aSelectedRuns.length < 2) {
                sap.m.MessageToast.show("Select at least 2 runs to compare");
                return;
            }
            
            // Get run IDs
            var aRunIds = aSelectedRuns.map(function(r) { return r.runId; });
            var sProjectId = oDashboardModel.getProperty("/projectId");
            
            // Navigate to comparison page with run IDs as query parameter
            this.getOwnerComponent().getRouter().navTo("runComparison", {
                projectId: sProjectId,
                "?query": {
                    runs: aRunIds.join(",")
                }
            });
        },

        /**
         * Handle table update to load node counts for newly visible rows
         */
        onExecutionsTableUpdate: function (oEvent) {
            var oTable = oEvent.getSource();
            var aItems = oTable.getItems();
            var sBaseUrl = this._getPySrvUrl();
            var oDashboardModel = this.getView().getModel("dashboard");
            
            // Find runs without node data loaded yet
            var aRunsToLoad = [];
            aItems.forEach(function(oItem) {
                var oContext = oItem.getBindingContext("dashboard");
                if (oContext) {
                    var oRun = oContext.getObject();
                    // Check if node data hasn't been loaded (totalSteps is undefined or explicitly 0 with no load attempt)
                    if (oRun && oRun.runId && oRun.totalSteps === undefined) {
                        aRunsToLoad.push({
                            run: oRun,
                            path: oContext.getPath()
                        });
                    }
                }
            });
            
            if (aRunsToLoad.length === 0) {
                return;
            }
            
            // Load node data for runs that need it (max 10 at a time for performance)
            var aToLoad = aRunsToLoad.slice(0, 10);
            var that = this;
            
            aToLoad.forEach(function(item) {
                that._fetchDsp(sBaseUrl + "/v1/dsp/taskchain-run-nodes?chainTaskLogId=" + encodeURIComponent(item.run.runId))
                    .then(function(r) { return r.json(); })
                    .then(function(result) {
                        if (result.success && result.nodes) {
                            var aNodes = result.nodes;
                            oDashboardModel.setProperty(item.path + "/stepsCompleted", aNodes.filter(function(n) { return n.status === "success"; }).length);
                            oDashboardModel.setProperty(item.path + "/stepsRunning", aNodes.filter(function(n) { return n.status === "running" || n.status === "pending"; }).length);
                            oDashboardModel.setProperty(item.path + "/stepsFailed", aNodes.filter(function(n) { return n.status === "error"; }).length);
                            oDashboardModel.setProperty(item.path + "/totalSteps", aNodes.length);
                        } else {
                            // Mark as loaded but with 0
                            oDashboardModel.setProperty(item.path + "/stepsCompleted", 0);
                            oDashboardModel.setProperty(item.path + "/stepsRunning", 0);
                            oDashboardModel.setProperty(item.path + "/stepsFailed", 0);
                            oDashboardModel.setProperty(item.path + "/totalSteps", 0);
                        }
                    })
                    .catch(function() {
                        oDashboardModel.setProperty(item.path + "/totalSteps", 0);
                    });
            });
        }
    });
});
