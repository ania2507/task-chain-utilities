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

            // Connect the hover tooltip to the chart — without this, VizFrame shows no
            // tooltip at all on hover (it isn't wired automatically by the framework).
            var oChart = this.byId("executionChart");
            var oTooltip = this.byId("executionChartTooltip");
            if (oChart && oTooltip) {
                oChart.attachRenderComplete(function () {
                    oTooltip.connect(oChart.getVizUid());
                });
            }
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
                errors: 0,
                avgDurationP95: 0,
                avgDurationP95Display: "-",
                durationStdDev: 0,
                durationStdDevDisplay: "-",
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
                selectedTimePeriodKey: "24h",
                customDateFrom: null,
                customDateTo: null,
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

            // Load executions from DSP for each task chain. The chain filter that was
            // active before drilling down into a run/task (e.g. via Run Inspector's back
            // button) is restored once this finishes loading — restoring it any earlier
            // would apply the filter against the still-empty /allExecutions and then get
            // silently overwritten once the load completes.
            this._loadExecutionsFromDSP(aTaskChains, oDashboardModel, sProjectId);

            // Business names aren't persisted with the project's task chain list (only
            // spaceId/name are) — look them up live from DSP's own catalog so they stay
            // correct even if a chain gets renamed on the DSP side later.
            this._enrichTaskChainsWithBusinessNames(oDashboardModel);
        },

        /**
         * Stash the currently selected chain filter (if any) for this project, so a
         * subsequent return to the dashboard (e.g. browser back from Run Inspector or
         * Task Chain Detail) can restore it instead of resetting to "all chains".
         */
        _stashChainFilterState: function (sProjectId) {
            var oDashboardModel = this.getView().getModel("dashboard");
            if (!oDashboardModel) return;
            var aSelectedChains = oDashboardModel.getProperty("/selectedChains") || [];
            var oComp = this.getOwnerComponent();
            oComp._chainFilterState = aSelectedChains.length
                ? { projectId: sProjectId, selectedChains: aSelectedChains }
                : null;
        },

        /**
         * Re-apply a previously stashed chain filter (see _stashChainFilterState) for
         * this project, including re-selecting the matching rows in the Task Chains list.
         */
        _restoreChainFilterState: function (sProjectId, oDashboardModel) {
            var oComp = this.getOwnerComponent();
            var oState = oComp._chainFilterState;
            if (!oState || oState.projectId !== sProjectId) return;
            oComp._chainFilterState = null;

            var aSelectedChains = oState.selectedChains;
            oDashboardModel.setProperty("/selectedChains", aSelectedChains);
            oDashboardModel.setProperty("/selectedChainsCount", aSelectedChains.length);
            this._applyChainFilter(aSelectedChains);

            // The list's items are (re)created from the fresh /taskChains binding just set
            // on this new JSONModel instance — defer selection to the next tick so the
            // items actually exist to select.
            var oList = this.byId("taskChainsList");
            setTimeout(function () {
                if (!oList) return;
                var aKeys = aSelectedChains.map(function (c) { return c.spaceId + "|" + c.name; });
                oList.getItems().forEach(function (oItem) {
                    var oCtx = oItem.getBindingContext("dashboard");
                    var oChain = oCtx && oCtx.getObject();
                    if (oChain && aKeys.indexOf(oChain.spaceId + "|" + oChain.name) !== -1) {
                        oList.setSelectedItem(oItem, true);
                    }
                });
            }, 0);
        },

        /**
         * Best-effort: fetch DSP's live Taskchain catalog and fill in each project task
         * chain's businessName by matching on (spaceId, name). Never blocks the rest of
         * the dashboard — on any failure the list simply keeps showing technical names.
         */
        _enrichTaskChainsWithBusinessNames: function (oDashboardModel) {
            var sServiceUrl = this.getOwnerComponent().getManifestObject().resolveUri("odata/v4/services/");
            fetch(sServiceUrl + "Taskchain", { credentials: "same-origin" })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    var oByKey = {};
                    (data.value || []).forEach(function (tc) {
                        oByKey[tc.spaceId + "|" + tc.name] = tc.businessName;
                    });
                    var aTaskChains = (oDashboardModel.getProperty("/taskChains") || []).map(function (tc) {
                        var sBusinessName = oByKey[tc.spaceId + "|" + tc.name];
                        return sBusinessName ? Object.assign({}, tc, { businessName: sBusinessName }) : tc;
                    });
                    oDashboardModel.setProperty("/taskChains", aTaskChains);
                })
                .catch(function (err) {
                    console.warn("[Dashboard] Could not enrich task chains with business names:", err && err.message);
                });
        },

        /**
         * Load task chain executions from DSP API
         */
        _loadExecutionsFromDSP: function (aTaskChains, oDashboardModel, sProjectId) {
            if (!aTaskChains || aTaskChains.length === 0) {
                oDashboardModel.setProperty("/loading", false);
                this._restoreChainFilterState(sProjectId, oDashboardModel);
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
                    aRecentRuns.forEach(function(run, idx) {
                        var nodeResult = aNodeResults[idx];
                        if (nodeResult.success && nodeResult.nodes) {
                            var aNodes = nodeResult.nodes;
                            run.stepsCompleted = aNodes.filter(function(n) { return n.status === "success"; }).length;
                            run.stepsRunning = aNodes.filter(function(n) { return n.status === "running" || n.status === "pending"; }).length;
                            run.stepsFailed = aNodes.filter(function(n) { return n.status === "error"; }).length;
                            run.totalSteps = aNodes.length;
                        }
                        // else: leave stepsCompleted/stepsRunning/stepsFailed/totalSteps undefined
                        // so onExecutionsTableUpdate's lazy-load retries it later, same as
                        // older runs beyond the first 10 (see below) - and so _computeKpis'
                        // "totalSteps !== undefined" check doesn't count it as a zero-step run.

                        // Calculate duration display - for running, show elapsed time
                        if (run.status === "running" && run.startTime) {
                            var now = new Date();
                            var start = new Date(run.startTime);
                            var elapsedMin = (now - start) / 60000;
                            run.durationDisplay = that.formatter.formatDurationMinutes(elapsedMin) + " (running)";
                        } else if (run.duration && typeof run.duration === "number") {
                            run.durationDisplay = that.formatter.formatDurationMinutes(run.duration);
                        } else {
                            run.durationDisplay = "-";
                        }
                    });

                    // For older runs without node data, leave undefined for lazy loading
                    aAllRuns.slice(10).forEach(function(run) {
                        // Don't set step counts - leave undefined so lazy loading picks them up
                        if (run.duration && typeof run.duration === "number") {
                            run.durationDisplay = that.formatter.formatDurationMinutes(run.duration);
                        } else {
                            run.durationDisplay = "-";
                        }
                    });

                    // Calculate all 7 KPIs over the default time period (matches timePeriodSelect's default)
                    var oKpis = that._computeKpis(aAllRuns, "24h");
                    var oCutoff = that._getTimePeriodCutoff("24h");
                    var aTimeFilteredRuns = aAllRuns.filter(function (e) { return new Date(e.startTime) >= oCutoff; });

                    // Update model
                    oDashboardModel.setProperty("/allExecutions", aAllRuns);
                    oDashboardModel.setProperty("/filteredExecutions", aAllRuns);
                    // Recent Executions (and both exports, which read this same property)
                    // respect the default time period too, not just the full history.
                    oDashboardModel.setProperty("/recentExecutions", aTimeFilteredRuns);
                    oDashboardModel.setProperty("/totalExecutions", oKpis.totalExecutions);
                    oDashboardModel.setProperty("/successRate", oKpis.successRate);
                    oDashboardModel.setProperty("/errors", oKpis.errors);
                    oDashboardModel.setProperty("/avgDurationP95", oKpis.avgDurationP95);
                    oDashboardModel.setProperty("/avgDurationP95Display", oKpis.avgDurationP95Display);
                    oDashboardModel.setProperty("/durationStdDev", oKpis.durationStdDev);
                    oDashboardModel.setProperty("/durationStdDevDisplay", oKpis.durationStdDevDisplay);
                    oDashboardModel.setProperty("/avgStepsExecuted", oKpis.avgStepsExecuted);
                    oDashboardModel.setProperty("/avgStepsFailed", oKpis.avgStepsFailed);
                    oDashboardModel.setProperty("/kpiPeriodLabel", that._getTimePeriodLabel("24h"));
                    oDashboardModel.setProperty("/executionChartData", that._generateChartDataFromExecutions(aAllRuns, "related"));
                    oDashboardModel.setProperty("/topFailingTasks", that._getTopFailingTasks(aTimeFilteredRuns));
                    oDashboardModel.setProperty("/loading", false);
                    that.getOwnerComponent()._setBusy(false);

                    // Update project in monitoring model with real data
                    that._updateProjectStats(parseFloat(oKpis.successRate), oKpis.errors, parseFloat(oKpis.avgDurationP95), aTaskChains.length);

                    // Only now that /allExecutions is actually populated can a previously
                    // stashed chain filter be re-applied without being clobbered by the
                    // full-set values just written above.
                    that._restoreChainFilterState(sProjectId, oDashboardModel);
                }).catch(function(error) {
                    console.error("Error loading node details:", error);
                    oDashboardModel.setProperty("/loading", false);
                    that.getOwnerComponent()._setBusy(false);
                    that._restoreChainFilterState(sProjectId, oDashboardModel);
                });
            }.bind(this)).catch(function(error) {
                console.error("Error loading executions:", error);
                oDashboardModel.setProperty("/loading", false);
                that.getOwnerComponent()._setBusy(false);
                that._restoreChainFilterState(sProjectId, oDashboardModel);
            });
        },

        /**
         * Resolve a time-period key ('24h'/'7d'/'30d'/'365d'/'all') to its cutoff Date -
         * shared by KPI computation and both chart data generators so they always agree
         * on what each period means.
         */
        _getTimePeriodCutoff: function (sTimePeriod) {
            var now = new Date();
            switch (sTimePeriod) {
                case "7d":   return new Date(now.getTime() - 7   * 24 * 60 * 60 * 1000);
                case "30d":  return new Date(now.getTime() - 30  * 24 * 60 * 60 * 1000);
                case "365d": return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                case "all":  return new Date(0);
                case "custom": return this._getCustomDateBounds().start;
                default:     return new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24h
            }
        },

        /**
         * Upper bound for the selected time period. Every built-in period (24h/7d/...)
         * implicitly ends "now", since no run can have a future startTime — only "custom"
         * needs a real upper bound, taken from the end date picker (set to the end of that
         * day so the whole day is included).
         * @returns {Date|null} null for non-custom periods (no upper bound to apply)
         */
        _getTimePeriodUpperBound: function (sTimePeriod) {
            return sTimePeriod === "custom" ? this._getCustomDateBounds().end : null;
        },

        /**
         * Reads /customDateFrom and /customDateTo (plain Date objects from the DatePickers)
         * and normalizes them to a full-day range: start of the "from" day through end of
         * the "to" day. Falls back to an all-time range if either date isn't set yet.
         */
        _getCustomDateBounds: function () {
            var oDashboardModel = this.getView().getModel("dashboard");
            var oFrom = oDashboardModel.getProperty("/customDateFrom");
            var oTo = oDashboardModel.getProperty("/customDateTo");
            var oStart = oFrom
                ? new Date(oFrom.getFullYear(), oFrom.getMonth(), oFrom.getDate(), 0, 0, 0, 0)
                : new Date(0);
            var oEnd = oTo
                ? new Date(oTo.getFullYear(), oTo.getMonth(), oTo.getDate(), 23, 59, 59, 999)
                : new Date();
            return { start: oStart, end: oEnd };
        },

        /**
         * Number of whole days spanned by the custom range, used to pick a sensible chart
         * grouping granularity (see _generateChartDataFromExecutions/_generateDurationChartData).
         */
        _getCustomSpanDays: function () {
            var oBounds = this._getCustomDateBounds();
            return Math.max(1, Math.round((oBounds.end - oBounds.start) / (24 * 60 * 60 * 1000)));
        },

        /**
         * Maps a time-period key to the built-in tier ('24h'/'7d'/'30d'/'365d'/'all') whose
         * chart-grouping granularity should be used. Only "custom" needs mapping — its
         * granularity is picked from the span between the two chosen dates so short custom
         * ranges get hourly/daily buckets and long ones get weekly/monthly ones, same as the
         * fixed periods.
         */
        _getGroupingPeriod: function (sTimePeriod) {
            if (sTimePeriod !== "custom") {
                return sTimePeriod;
            }
            var iDays = this._getCustomSpanDays();
            if (iDays <= 2) return "24h";
            if (iDays <= 10) return "7d";
            if (iDays <= 60) return "30d";
            if (iDays <= 500) return "365d";
            return "all";
        },

        /**
         * Compute all 7 dashboard KPIs from a set of runs, restricted to the given time period.
         *
         * Works on either the full run set or a chain-filtered subset, so it can
         * be reused by both the initial load and _recomputeKpis.
         * Step-count KPIs (avgStepsExecuted/avgStepsFailed) only consider runs
         * whose node data has already been fetched (run.totalSteps !== undefined) -
         * older runs are lazy-loaded on scroll (see onExecutionsTableUpdate) and
         * are excluded until then, same as the original whole-project calculation.
         * @param {Array} aAllRuns - Runs to compute KPIs over (before time filtering)
         * @param {string} [sTimePeriod] - '24h'|'7d'|'30d'|'365d'|'all', defaults to '24h'
         * @returns {Object} KPI values, pre-formatted (toFixed) like the model expects
         */
        _computeKpis: function (aAllRuns, sTimePeriod) {
            sTimePeriod = sTimePeriod || "24h";
            var cutoffTime = this._getTimePeriodCutoff(sTimePeriod);
            var upperBound = this._getTimePeriodUpperBound(sTimePeriod);
            var aRuns = aAllRuns.filter(function (e) {
                var oStart = new Date(e.startTime);
                return oStart >= cutoffTime && (!upperBound || oStart <= upperBound);
            });

            var iTotalCount = aRuns.length;
            var iSuccessCount = aRuns.filter(function(e) { return e.status === "success"; }).length;
            var fSuccessRate = iTotalCount > 0 ? (iSuccessCount / iTotalCount * 100) : 100;

            // Errors within the selected period: chain's own final status only (consistent
            // with _getTopFailingTasks) - a run whose overall status is not "error" (e.g. a
            // step configured with "Ignore Error" in DSP) is not counted here even if one of
            // its steps individually failed.
            var iErrors = aRuns.filter(function(e) { return e.status === "error"; }).length;

            // Calculate Avg Duration (P95) and Std Dev
            var aDurations = aRuns
                .filter(function(e) { return e.duration && typeof e.duration === "number" && e.duration > 0; })
                .map(function(e) { return e.duration; })
                .sort(function(a, b) { return a - b; });

            var fAvgDurationP95 = 0;
            var fDurationStdDev = 0;
            if (aDurations.length > 0) {
                var iP95Index = Math.floor(aDurations.length * 0.95);
                iP95Index = Math.min(iP95Index, aDurations.length - 1);
                fAvgDurationP95 = aDurations[iP95Index];

                var fAvgDuration = aDurations.reduce(function(a, b) { return a + b; }, 0) / aDurations.length;
                if (aDurations.length > 1) {
                    var fVariance = aDurations.reduce(function(sum, val) {
                        return sum + Math.pow(val - fAvgDuration, 2);
                    }, 0) / aDurations.length;
                    fDurationStdDev = Math.sqrt(fVariance);
                }
            }

            // Calculate avg steps KPIs - only over runs whose node data is loaded
            var aRunsWithSteps = aRuns.filter(function(e) { return e.totalSteps !== undefined; });
            var iTotalSteps = aRunsWithSteps.reduce(function(sum, e) { return sum + (e.totalSteps || 0); }, 0);
            var iTotalFailedSteps = aRunsWithSteps.reduce(function(sum, e) { return sum + (e.stepsFailed || 0); }, 0);
            var fAvgSteps = aRunsWithSteps.length > 0 ? (iTotalSteps / aRunsWithSteps.length) : 0;
            var fAvgFailedSteps = aRunsWithSteps.length > 0 ? (iTotalFailedSteps / aRunsWithSteps.length) : 0;

            return {
                totalExecutions: iTotalCount,
                successRate: fSuccessRate.toFixed(1),
                errors: iErrors,
                // Kept numeric (decimal minutes) since other code parses these for
                // storage/threshold checks; *Display is the "Xm Ys" text for the KPI tile.
                avgDurationP95: fAvgDurationP95.toFixed(1),
                avgDurationP95Display: this.formatter.formatDurationMinutes(fAvgDurationP95),
                durationStdDev: fDurationStdDev.toFixed(1),
                durationStdDevDisplay: this.formatter.formatDurationMinutes(fDurationStdDev),
                avgStepsExecuted: fAvgSteps.toFixed(1),
                avgStepsFailed: fAvgFailedSteps.toFixed(2)
            };
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
            var cutoffTime = this._getTimePeriodCutoff(sTimePeriod);
            var upperBound = this._getTimePeriodUpperBound(sTimePeriod);
            // "custom" has no grouping rules of its own — pick the built-in tier whose
            // granularity best fits the chosen date span (see _getGroupingPeriod).
            var sGroupPeriod = this._getGroupingPeriod(sTimePeriod);

            // Filter by time period
            var aFiltered = aExecutions.filter(function(exec) {
                var execTime = new Date(exec.startTime || exec.timestamp);
                return execTime >= cutoffTime && (!upperBound || execTime <= upperBound);
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

                if (sGroupPeriod === "24h") {
                    // Group by hour
                    var hour = execDate.getHours();
                    sKey = (hour < 10 ? "0" : "") + hour + ":00";
                } else if (sGroupPeriod === "7d") {
                    // Group by day of week
                    var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
                    var monthsShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                    sKey = days[execDate.getDay()] + " " + execDate.getDate() + " " + monthsShort[execDate.getMonth()];
                } else if (sGroupPeriod === "30d") {
                    // Group by day
                    var monthsShort30d = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                    sKey = execDate.getDate() + " " + monthsShort30d[execDate.getMonth()];
                } else if (sGroupPeriod === "365d") {
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
                // Only a genuine failure counts as an error — a run that's still
                // "running"/"pending" isn't a failure and shouldn't inflate the error bar.
                if (exec.status === "success") {
                    oGroupedData[sKey].successes++;
                } else if (exec.status === "error") {
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
                        avgLatency = formatter.formatDurationMinutes(data.totalDuration / data.count);
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
         * Handle task chain selection in the "Add Task Chain" dialog's own list
         * (availableChainsList) — distinct from onChainSelectionChange below, which
         * handles the dashboard's main taskChainsList (chart/KPI chain filter). These
         * used to share the same name and the second definition silently shadowed this
         * one, so checking a box here was actually re-running the dashboard's chain
         * filter against whatever was selected in the unrelated main list.
         */
        onAvailableChainSelectionChange: function (oEvent) {
            var aSelectedItems = oEvent.getParameter("listItems") || oEvent.getSource().getSelectedItems();
            var aSelectedChains = aSelectedItems.map(function(item) {
                var oCtx = item.getBindingContext("availableChains");
                return oCtx ? oCtx.getObject() : null;
            }).filter(Boolean);
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
                that.getOwnerComponent()._setBusy(false);
            }).catch(function(oError) {
                console.error("[Dashboard] Error adding chains:", oError);
                MessageBox.error("Error adding task chains: " + oError.message);
                that.getOwnerComponent()._setBusy(false);
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
                        that.getOwnerComponent()._setBusy(false);
                    }).catch(function(oError) {
                        MessageBox.error("Error removing task chain: " + oError.message);
                        that.getOwnerComponent()._setBusy(false);
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
            if (sTimePeriod === "custom") {
                // Just reveals the From/To date pickers (see the view's visible binding on
                // /selectedTimePeriodKey) — wait for onCustomDateChange to fire once both
                // dates are actually picked before recomputing anything.
                return;
            }
            this._updateChartData(null, sTimePeriod);
            this._updateKPIsForFilteredData(this.getView().getModel("dashboard").getProperty("/filteredExecutions") || [], sTimePeriod);
        },

        /**
         * Handle custom date range change (From/To pickers, shown when the Period select is
         * set to "custom"). Fires on each picker's change event; only recomputes once both
         * dates are set and the range is valid, so an incomplete pick doesn't trigger a
         * bogus all-time-defaulted recompute.
         */
        onCustomDateChange: function () {
            var oDashboardModel = this.getView().getModel("dashboard");
            var oFrom = oDashboardModel.getProperty("/customDateFrom");
            var oTo = oDashboardModel.getProperty("/customDateTo");
            if (!oFrom || !oTo) {
                return;
            }
            if (oFrom > oTo) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("dashboard.invalidDateRange"));
                return;
            }
            this._updateChartData(null, "custom");
            this._updateKPIsForFilteredData(oDashboardModel.getProperty("/filteredExecutions") || [], "custom");
        },

        /**
         * Update chart data based on current filters
         * @param {string} sFilterMode - Optional new filter mode
         * @param {string} sTimePeriod - Optional new time period
         */
        _updateChartData: function (sFilterMode, sTimePeriod) {
            var oDashboardModel = this.getView().getModel("dashboard");
            // Always use the currently filtered set so chain selection is respected
            var aExecutions = oDashboardModel.getProperty("/filteredExecutions") || [];
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
                this._configureChartForDuration(oChart);
                oDashboardModel.setProperty("/executionChartData", this._generateDurationChartData(aExecutions, sTimePeriod));
            } else {
                this._configureChartForExecutions(oChart);
                oDashboardModel.setProperty("/executionChartData", this._generateChartDataFromExecutions(aExecutions, sFilterMode, sTimePeriod));
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
         * Generate duration chart data for last runs.
         * - 24h / 7d : individual run points (max 100)
         * - 30d      : daily averages
         * - 365d     : weekly averages
         * - all      : monthly averages
         */
        _generateDurationChartData: function (aExecutions, sTimePeriod) {
            if (!aExecutions || aExecutions.length === 0) {
                return [];
            }

            sTimePeriod = sTimePeriod || "24h";
            var cutoffTime = this._getTimePeriodCutoff(sTimePeriod);
            var upperBound = this._getTimePeriodUpperBound(sTimePeriod);
            var sGroupPeriod = this._getGroupingPeriod(sTimePeriod);

            var aFiltered = aExecutions.filter(function (exec) {
                var execTime = new Date(exec.startTime);
                return execTime >= cutoffTime && (!upperBound || execTime <= upperBound) && exec.duration && exec.duration > 0;
            });

            aFiltered.sort(function (a, b) {
                return new Date(a.startTime) - new Date(b.startTime);
            });

            // Global average and stddev (across the entire filtered set)
            var aDurations = aFiltered.map(function (e) { return e.duration; });
            var fAvg = 0, fStdDev = 0;
            if (aDurations.length > 0) {
                fAvg = aDurations.reduce(function (a, b) { return a + b; }, 0) / aDurations.length;
                if (aDurations.length > 1) {
                    var fVar = aDurations.reduce(function (s, v) { return s + Math.pow(v - fAvg, 2); }, 0) / aDurations.length;
                    fStdDev = Math.sqrt(fVar);
                }
            }
            var fStdHigh = parseFloat((fAvg + fStdDev).toFixed(1));
            var fStdLow  = parseFloat(Math.max(0, fAvg - fStdDev).toFixed(1));
            fAvg = parseFloat(fAvg.toFixed(1));

            // For short periods show individual runs (max 100); for longer periods aggregate
            var useAggregate = (sGroupPeriod === "30d" || sGroupPeriod === "365d" || sGroupPeriod === "all");

            var monthsShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

            if (!useAggregate) {
                // Individual run points
                var aPoints = aFiltered.length > 100 ? aFiltered.slice(-100) : aFiltered;
                return aPoints.map(function (exec) {
                    var d = new Date(exec.startTime);
                    var sLabel = sGroupPeriod === "24h"
                        ? d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes()
                        : d.getDate() + " " + monthsShort[d.getMonth()] + " " + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
                    return {
                        time: sLabel,
                        duration: parseFloat(exec.duration.toFixed(1)),
                        avg: fAvg,
                        stdHigh: fStdHigh,
                        stdLow: fStdLow,
                        successes: 0,
                        errors: 0
                    };
                });
            }

            // Aggregate into buckets
            var oBuckets = {};
            aFiltered.forEach(function (exec) {
                var d = new Date(exec.startTime);
                var sKey;
                if (sGroupPeriod === "30d") {
                    // Daily bucket
                    sKey = d.getDate() + " " + monthsShort[d.getMonth()];
                } else if (sGroupPeriod === "365d") {
                    // Weekly bucket: Mon date of the week
                    var dayOfWeek = d.getDay(); // 0=Sun
                    var monday = new Date(d.getTime() - ((dayOfWeek === 0 ? 6 : dayOfWeek - 1) * 86400000));
                    sKey = monday.getDate() + " " + monthsShort[monday.getMonth()];
                } else {
                    // Monthly bucket: Jan 2026
                    sKey = monthsShort[d.getMonth()] + " " + d.getFullYear();
                }
                if (!oBuckets[sKey]) {
                    oBuckets[sKey] = { sum: 0, count: 0, sortKey: d.getTime() };
                }
                oBuckets[sKey].sum += exec.duration;
                oBuckets[sKey].count++;
            });

            var aKeys = Object.keys(oBuckets).sort(function (a, b) {
                return oBuckets[a].sortKey - oBuckets[b].sortKey;
            });

            return aKeys.map(function (key) {
                var fBucketAvg = parseFloat((oBuckets[key].sum / oBuckets[key].count).toFixed(1));
                return {
                    time: key,
                    duration: fBucketAvg,
                    avg: fAvg,
                    stdHigh: fStdHigh,
                    stdLow: fStdLow,
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

            this._stashChainFilterState(sProjectId);
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

            this._stashChainFilterState(sProjectId);
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
            this._stashChainFilterState(sProjectId);
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
            
            // Reset to all executions — /recentExecutions is set below by
            // _updateKPIsForFilteredData, which also re-applies the time period filter.
            var aAllExecutions = oDashboardModel.getProperty("/allExecutions") || [];
            oDashboardModel.setProperty("/filteredExecutions", aAllExecutions);

            // Update chart — _updateChartData reads from filteredExecutions automatically
            this._updateChartData(null, null);

            // Restore whole-project KPIs (previously left stale from the last filter)
            this._updateKPIsForFilteredData(aAllExecutions);
        },

        /**
         * Currently selected time period (reads the chart's Select control), used to keep
         * KPI recomputation in sync with whatever period the user has chosen.
         */
        _getSelectedTimePeriod: function () {
            var oSelect = this.byId("timePeriodSelect");
            return (oSelect && oSelect.getSelectedKey()) || "24h";
        },

        /**
         * Friendly label for a time-period key, shown as the KPI tiles' subtitle so it's
         * clear which window (matching the chart's own Period selector) they reflect.
         */
        _getTimePeriodLabel: function (sTimePeriod) {
            var oRb = this.getView().getModel("i18n").getResourceBundle();
            switch (sTimePeriod) {
                case "7d":   return oRb.getText("dashboard.lastWeek");
                case "30d":  return oRb.getText("dashboard.lastMonth");
                case "365d": return oRb.getText("dashboard.lastYear");
                case "all":  return oRb.getText("dashboard.allTime");
                case "custom": return this._getCustomRangeLabel();
                default:     return oRb.getText("dashboard.last24h");
            }
        },

        /**
         * "DD Mon YYYY - DD Mon YYYY" label for the custom date range, shown as the KPI
         * tiles' subtitle in place of the fixed-period text.
         */
        _getCustomRangeLabel: function () {
            var oDashboardModel = this.getView().getModel("dashboard");
            var oFrom = oDashboardModel.getProperty("/customDateFrom");
            var oTo = oDashboardModel.getProperty("/customDateTo");
            var monthsShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            var fnFormat = function (d) {
                return d.getDate() + " " + monthsShort[d.getMonth()] + " " + d.getFullYear();
            };
            if (!oFrom || !oTo) {
                return this.getView().getModel("i18n").getResourceBundle().getText("dashboard.incompleteDateRange");
            }
            return fnFormat(oFrom) + " - " + fnFormat(oTo);
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
            
            // /recentExecutions is set below by _updateKPIsForFilteredData, which also
            // re-applies the time period filter.
            oDashboardModel.setProperty("/filteredExecutions", aFiltered);

            // Update chart — _updateChartData reads from filteredExecutions automatically
            this._updateChartData(null, null);

            // Update KPIs for filtered data
            this._updateKPIsForFilteredData(aFiltered);
        },

        /**
         * Update KPIs based on filtered executions, restricted to the given (or currently
         * selected) time period — so the KPI tiles always agree with the chart.
         */
        _updateKPIsForFilteredData: function (aExecutions, sTimePeriod) {
            sTimePeriod = sTimePeriod || this._getSelectedTimePeriod();
            var oDashboardModel = this.getView().getModel("dashboard");
            var oKpis = this._computeKpis(aExecutions, sTimePeriod);

            oDashboardModel.setProperty("/totalExecutions", oKpis.totalExecutions);
            oDashboardModel.setProperty("/successRate", oKpis.successRate);
            oDashboardModel.setProperty("/errors", oKpis.errors);
            oDashboardModel.setProperty("/avgDurationP95", oKpis.avgDurationP95);
            oDashboardModel.setProperty("/avgDurationP95Display", oKpis.avgDurationP95Display);
            oDashboardModel.setProperty("/durationStdDev", oKpis.durationStdDev);
            oDashboardModel.setProperty("/durationStdDevDisplay", oKpis.durationStdDevDisplay);
            oDashboardModel.setProperty("/avgStepsExecuted", oKpis.avgStepsExecuted);
            oDashboardModel.setProperty("/avgStepsFailed", oKpis.avgStepsFailed);
            oDashboardModel.setProperty("/kpiPeriodLabel", this._getTimePeriodLabel(sTimePeriod));

            // Recent Executions table (and both the Excel/PowerPoint exports, which read
            // straight from /recentExecutions) must reflect the selected time period too,
            // not just the chain filter — otherwise they silently show/export the full
            // history regardless of what period is picked.
            var cutoffTime = this._getTimePeriodCutoff(sTimePeriod);
            var upperBound = this._getTimePeriodUpperBound(sTimePeriod);
            var aTimeFiltered = (aExecutions || []).filter(function (e) {
                var oStart = new Date(e.startTime);
                return oStart >= cutoffTime && (!upperBound || oStart <= upperBound);
            });
            oDashboardModel.setProperty("/recentExecutions", aTimeFiltered);
            oDashboardModel.setProperty("/topFailingTasks", this._getTopFailingTasks(aTimeFiltered));
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
            if (!this._oNodeCountsInFlight) this._oNodeCountsInFlight = {};

            // Find runs without node data loaded yet, skipping any whose fetch is
            // already in flight from a previous (possibly still-pending) call — see
            // the in-flight tracking note below for why that matters.
            var aRunsToLoad = [];
            aItems.forEach(function(oItem) {
                var oContext = oItem.getBindingContext("dashboard");
                if (oContext) {
                    var oRun = oContext.getObject();
                    if (oRun && oRun.runId && oRun.totalSteps === undefined && !this._oNodeCountsInFlight[oRun.runId]) {
                        aRunsToLoad.push({ run: oRun });
                    }
                }
            }.bind(this));

            if (aRunsToLoad.length === 0) {
                return;
            }

            // Load node data for runs that need it (max 10 at a time for performance)
            var aToLoad = aRunsToLoad.slice(0, 10);
            var that = this;

            var aPromises = aToLoad.map(function(item) {
                that._oNodeCountsInFlight[item.run.runId] = true;
                return that._fetchDsp(sBaseUrl + "/v1/dsp/taskchain-run-nodes?chainTaskLogId=" + encodeURIComponent(item.run.runId))
                    .then(function(r) { return r.json(); })
                    .then(function(result) {
                        // Mutate the run object directly rather than writing via an index
                        // path: a filter change while this fetch was in flight can replace
                        // /recentExecutions with a differently ordered/sized array, so an
                        // index captured earlier may no longer point at this run by the
                        // time the response arrives — writing through it would corrupt an
                        // unrelated row. The object reference itself stays valid and correct
                        // regardless of where (or whether) it currently sits in the array.
                        var oRun = item.run;
                        if (result.success && result.nodes) {
                            var aNodes = result.nodes;
                            oRun.stepsCompleted = aNodes.filter(function(n) { return n.status === "success"; }).length;
                            oRun.stepsRunning = aNodes.filter(function(n) { return n.status === "running" || n.status === "pending"; }).length;
                            oRun.stepsFailed = aNodes.filter(function(n) { return n.status === "error"; }).length;
                            oRun.totalSteps = aNodes.length;
                        } else {
                            // Mark as loaded but with 0
                            oRun.stepsCompleted = 0;
                            oRun.stepsRunning = 0;
                            oRun.stepsFailed = 0;
                            oRun.totalSteps = 0;
                        }
                    })
                    .catch(function() {
                        item.run.totalSteps = 0;
                    })
                    .then(function() {
                        delete that._oNodeCountsInFlight[item.run.runId];
                    });
            });

            // One model refresh after the whole batch settles, instead of one per row.
            // checkUpdate(true) re-fires this table's own updateFinished (it's bound to
            // /recentExecutions), so refreshing per-row re-entered this handler up to 10x
            // per batch — for a wide custom date range (many never-before-loaded rows)
            // that cascade produced duplicate in-flight requests for the same runs and
            // made the last three columns' loading appear to hang instead of progressing.
            Promise.all(aPromises).then(function() {
                oDashboardModel.checkUpdate(true);
            });
        },

        // ------------------------------------------------------------
        // Excel export (chart data + Recent Executions table)
        // ------------------------------------------------------------
        // The XLSX (SheetJS) library is vendored under this component's own
        // "thirdparty" folder — fetched dynamically here (rather than via a
        // <script> tag) so it also works when this component is embedded inside
        // a different shell (e.g. the "home" app), same approach as the
        // Scheduler app's Custom Calendar template download.
        _ensureXlsxLoaded: function () {
            if (window.XLSX && window.XLSX.utils) return Promise.resolve();
            if (this._pXlsxLoad) return this._pXlsxLoad;
            var sUrl = sap.ui.require.toUrl("monitoring/thirdparty/xlsx.full.min.js");
            var that = this;
            this._pXlsxLoad = new Promise(function (resolve, reject) {
                var savedDefine = window.define;
                window.define = undefined;
                var script = document.createElement("script");
                script.src = sUrl;
                script.onload = function () {
                    window.define = savedDefine;
                    if (window.XLSX && window.XLSX.utils) {
                        resolve();
                    } else {
                        reject(new Error("XLSX script loaded but window.XLSX.utils is missing"));
                    }
                };
                script.onerror = function () {
                    window.define = savedDefine;
                    reject(new Error("Failed to load XLSX library from " + sUrl));
                };
                document.head.appendChild(script);
            }).catch(function (err) {
                that._pXlsxLoad = null;
                throw err;
            });
            return this._pXlsxLoad;
        },

        _downloadBlob: function (oBlob, sFilename) {
            var sUrl = window.URL.createObjectURL(oBlob);
            var a = document.createElement("a");
            a.href = sUrl; a.download = sFilename;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(sUrl);
        },

        /**
         * Export both the chart's current data (whatever period/mode is selected)
         * and the Recent Executions table to a single .xlsx file, one sheet each.
         */
        onExportExcel: function () {
            var that = this;
            this.getOwnerComponent()._setBusy(true);
            Promise.all([
                this._ensureXlsxLoaded(),
                this._ensureStepCountsLoaded(this.getView().getModel("dashboard").getProperty("/recentExecutions") || [])
            ]).then(function () {
                that.getOwnerComponent()._setBusy(false);
                that._buildAndDownloadExcelExport();
            }).catch(function (err) {
                that.getOwnerComponent()._setBusy(false);
                console.error("[Dashboard] Could not load XLSX library:", err && err.message);
                MessageBox.error("Could not generate the Excel export. Please reload the page and try again.");
            });
        },

        /**
         * Recent Executions rows load their step counts (stepsCompleted/Running/Failed)
         * lazily as they scroll into view on screen (see onExecutionsTableUpdate) — a row
         * never scrolled to still has totalSteps === undefined. An export must be complete
         * regardless of what's been scrolled, so fetch node details for any row still
         * missing them before generating the file.
         */
        _ensureStepCountsLoaded: function (aExecutions) {
            var aMissing = (aExecutions || []).filter(function (e) { return e.totalSteps === undefined; });
            if (!aMissing.length) return Promise.resolve();

            var sBaseUrl = this._getPySrvUrl();
            var that = this;
            var aPromises = aMissing.map(function (run) {
                return that._fetchDsp(sBaseUrl + "/v1/dsp/taskchain-run-nodes?chainTaskLogId=" + encodeURIComponent(run.runId))
                    .then(function (r) { return r.json(); })
                    .then(function (result) {
                        var aNodes = (result.success && result.nodes) || [];
                        run.stepsCompleted = aNodes.filter(function (n) { return n.status === "success"; }).length;
                        run.stepsRunning = aNodes.filter(function (n) { return n.status === "running" || n.status === "pending"; }).length;
                        run.stepsFailed = aNodes.filter(function (n) { return n.status === "error"; }).length;
                        run.totalSteps = aNodes.length;
                    })
                    .catch(function () {
                        run.stepsCompleted = 0; run.stepsRunning = 0; run.stepsFailed = 0; run.totalSteps = 0;
                    });
            });
            return Promise.all(aPromises).then(function () {
                // Refresh the on-screen table too, now that these rows have real data.
                var oDashboardModel = that.getView().getModel("dashboard");
                oDashboardModel.setProperty("/recentExecutions", (oDashboardModel.getProperty("/recentExecutions") || []).slice());
            });
        },

        _buildAndDownloadExcelExport: function () {
            var XLSX = window.XLSX;
            var oDashboardModel = this.getView().getModel("dashboard");
            var oProjectName = oDashboardModel.getProperty("/projectName") || "project";
            var sFilterMode = this.byId("chartFilter").getSelectedKey();
            var sTimePeriod = this._getSelectedTimePeriod();

            var wb = XLSX.utils.book_new();

            // Sheet 1 ("Overview"): an info block (Project/Task Chain(s)/Period) followed
            // by the chart data as currently displayed (period + mode aware). The chart
            // data itself is aggregated across whatever chains are filtered, so it isn't a
            // per-row value — showing it once alongside the other filters is clearer than
            // repeating the same string down its own column.
            var aChartData = oDashboardModel.getProperty("/executionChartData") || [];
            var bDuration = sFilterMode === "durationTrend";
            var aSelectedChains = oDashboardModel.getProperty("/selectedChains") || [];
            var sChainsInfo = aSelectedChains.length
                ? aSelectedChains.map(function (c) { return c.businessName || c.name; }).join(", ")
                : "All Task Chains";
            var aChartRows = [
                ["Project", oProjectName],
                ["Task Chain(s)", sChainsInfo],
                ["Period", this._getTimePeriodLabel(sTimePeriod)],
                [],
                bDuration
                    ? ["Time", "Duration (min)", "Avg (min)", "+1 StdDev", "-1 StdDev"]
                    : ["Time", "Successes", "Errors"]
            ];
            aChartData.forEach(function (row) {
                aChartRows.push(bDuration
                    ? [row.time, row.duration, row.avg, row.stdHigh, row.stdLow]
                    : [row.time, row.successes, row.errors]);
            });
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aChartRows), "Overview");

            // Sheet 2: Recent Executions table, respecting the current chain filter
            var aExecutions = oDashboardModel.getProperty("/recentExecutions") || [];
            var aExecRows = [["Task Chain", "Run ID", "Start", "End", "Duration", "Status",
                "Steps Completed", "Steps Running", "Steps Failed"]];
            aExecutions.forEach(function (e) {
                aExecRows.push([
                    e.taskChain || "", e.runId || "",
                    this.formatter.formatDateTime(e.startTime), this.formatter.formatDateTime(e.endTime),
                    this.formatter.formatDurationMinutes(e.duration), e.status || "",
                    e.stepsCompleted != null ? e.stepsCompleted : "",
                    e.stepsRunning != null ? e.stepsRunning : "",
                    e.stepsFailed != null ? e.stepsFailed : ""
                ]);
            }.bind(this));
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aExecRows), "Executions");

            var out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
            var sSafeName = String(oProjectName).replace(/[^a-z0-9]+/gi, "_");
            this._downloadBlob(new Blob([out], { type: "application/octet-stream" }),
                sSafeName + "_" + sTimePeriod + ".xlsx");
        },

        // ------------------------------------------------------------
        // PowerPoint export (native chart + data table) — PptxGenJS produces a
        // genuinely editable chart object in the .pptx (unlike the Excel export,
        // which is data-only: the free SheetJS build can't write charts or images).
        // ------------------------------------------------------------
        _ensurePptxGenLoaded: function () {
            if (window.PptxGenJS) return Promise.resolve();
            if (this._pPptxLoad) return this._pPptxLoad;
            var sUrl = sap.ui.require.toUrl("monitoring/thirdparty/pptxgen.bundle.js");
            var that = this;
            this._pPptxLoad = new Promise(function (resolve, reject) {
                var savedDefine = window.define;
                window.define = undefined;
                var script = document.createElement("script");
                script.src = sUrl;
                script.onload = function () {
                    window.define = savedDefine;
                    if (window.PptxGenJS) {
                        resolve();
                    } else {
                        reject(new Error("PptxGenJS script loaded but window.PptxGenJS is missing"));
                    }
                };
                script.onerror = function () {
                    window.define = savedDefine;
                    reject(new Error("Failed to load PptxGenJS library from " + sUrl));
                };
                document.head.appendChild(script);
            }).catch(function (err) {
                that._pPptxLoad = null;
                throw err;
            });
            return this._pPptxLoad;
        },

        onExportPowerPoint: function () {
            var that = this;
            this.getOwnerComponent()._setBusy(true);
            Promise.all([
                this._ensurePptxGenLoaded(),
                this._ensureStepCountsLoaded(this.getView().getModel("dashboard").getProperty("/recentExecutions") || [])
            ]).then(function () {
                that.getOwnerComponent()._setBusy(false);
                that._buildAndDownloadPowerPoint();
            }).catch(function (err) {
                that.getOwnerComponent()._setBusy(false);
                console.error("[Dashboard] Could not load PptxGenJS library:", err && err.message);
                MessageBox.error("Could not generate the PowerPoint export. Please reload the page and try again.");
            });
        },

        // Adds one slide with a native stacked-column chart (Successes/Errors shaped
        // data, as produced by _generateChartDataFromExecutions).
        _addBarChartSlide: function (pptx, sProjectName, sTitle, aChartData, sChainsInfo, sPeriodLabel) {
            var oSlide = pptx.addSlide();
            oSlide.addText(sProjectName + " — " + sTitle,
                { x: 0.3, y: 0.2, w: 9.4, h: 0.4, fontSize: 18, bold: true });
            oSlide.addText("Task Chain(s): " + sChainsInfo + "   |   Period: " + sPeriodLabel,
                { x: 0.3, y: 0.62, w: 9.4, h: 0.3, fontSize: 11, italic: true, color: "666666" });
            var aLabels = aChartData.map(function (r) { return String(r.time); });
            if (!aLabels.length) {
                oSlide.addText("No data for the current period/filter.", { x: 0.3, y: 1.1, w: 9, h: 0.5, fontSize: 12, italic: true });
                return;
            }
            var aSeries = [
                { name: "Successes", labels: aLabels, values: aChartData.map(function (r) { return r.successes || 0; }) },
                { name: "Errors", labels: aLabels, values: aChartData.map(function (r) { return r.errors || 0; }) }
            ];
            oSlide.addChart(pptx.ChartType.bar, aSeries, {
                x: 0.3, y: 1.0, w: 9.4, h: 4.2,
                barDir: "col", barGrouping: "stacked",
                chartColors: ["107E3E", "BB0000"],
                showLegend: true, legendPos: "b",
                showTitle: false,
                catAxisTitle: "Time", valAxisTitle: "Executions"
            });
        },

        // Adds one slide with a native line chart (Duration/Avg shaped data, as
        // produced by _generateDurationChartData).
        _addDurationChartSlide: function (pptx, sProjectName, sTitle, aChartData, sChainsInfo, sPeriodLabel) {
            var oSlide = pptx.addSlide();
            oSlide.addText(sProjectName + " — " + sTitle,
                { x: 0.3, y: 0.2, w: 9.4, h: 0.4, fontSize: 18, bold: true });
            oSlide.addText("Task Chain(s): " + sChainsInfo + "   |   Period: " + sPeriodLabel,
                { x: 0.3, y: 0.62, w: 9.4, h: 0.3, fontSize: 11, italic: true, color: "666666" });
            var aLabels = aChartData.map(function (r) { return String(r.time); });
            if (!aLabels.length) {
                oSlide.addText("No data for the current period/filter.", { x: 0.3, y: 1.1, w: 9, h: 0.5, fontSize: 12, italic: true });
                return;
            }
            var aSeries = [
                { name: "Duration", labels: aLabels, values: aChartData.map(function (r) { return r.duration || 0; }) },
                { name: "Avg", labels: aLabels, values: aChartData.map(function (r) { return r.avg || 0; }) }
            ];
            oSlide.addChart(pptx.ChartType.line, aSeries, {
                x: 0.3, y: 1.0, w: 9.4, h: 4.2,
                showLegend: true, legendPos: "b",
                showTitle: false,
                catAxisTitle: "Time", valAxisTitle: "Duration (min)"
            });
        },

        _buildAndDownloadPowerPoint: function () {
            var oDashboardModel = this.getView().getModel("dashboard");
            var sProjectName = oDashboardModel.getProperty("/projectName") || "project";
            var sTimePeriod = this._getSelectedTimePeriod();
            // Same chain-filtered base set the on-screen chart uses — each of the three
            // chart slides below applies its own mode filter independently, so the
            // export always has all three views regardless of which one is selected
            // on screen (they don't share one filtered dataset, see the three separate
            // generator calls).
            var aBaseExecutions = oDashboardModel.getProperty("/filteredExecutions") || [];

            var aSelectedChains = oDashboardModel.getProperty("/selectedChains") || [];
            var sChainsInfo = aSelectedChains.length
                ? aSelectedChains.map(function (c) { return c.businessName || c.name; }).join(", ")
                : "All Task Chains";
            var sPeriodLabel = this._getTimePeriodLabel(sTimePeriod);

            var pptx = new window.PptxGenJS();
            pptx.title = sProjectName;

            // Slides 1-3: one native, editable chart per view mode.
            this._addBarChartSlide(pptx, sProjectName, "Successes vs Errors",
                this._generateChartDataFromExecutions(aBaseExecutions, "related", sTimePeriod), sChainsInfo, sPeriodLabel);
            this._addBarChartSlide(pptx, sProjectName, "Errors Only",
                this._generateChartDataFromExecutions(aBaseExecutions, "errors", sTimePeriod), sChainsInfo, sPeriodLabel);
            this._addDurationChartSlide(pptx, sProjectName, "Duration Trend",
                this._generateDurationChartData(aBaseExecutions, sTimePeriod), sChainsInfo, sPeriodLabel);

            // Slide(s) 4+: Recent Executions table, respecting the current chain filter.
            // Paginated manually in fixed-size chunks rather than relying on PptxGenJS's
            // own autoPage option, which has known bugs with repeated/overflowing tables.
            var aExecutions = oDashboardModel.getProperty("/recentExecutions") || [];
            var aHeaderRow = ["Task Chain", "Run ID", "Start", "End", "Duration", "Status"].map(function (h) {
                return { text: h, options: { bold: true, color: "FFFFFF", fill: { color: "0A6ED1" } } };
            });
            var aDataRows = aExecutions.map(function (e) {
                return [e.taskChain || "", e.runId || "",
                    this.formatter.formatDateTime(e.startTime), this.formatter.formatDateTime(e.endTime),
                    this.formatter.formatDurationMinutes(e.duration), e.status || ""];
            }.bind(this));

            var ROWS_PER_SLIDE = 18;
            var aChunks = [];
            for (var i = 0; i < aDataRows.length; i += ROWS_PER_SLIDE) {
                aChunks.push(aDataRows.slice(i, i + ROWS_PER_SLIDE));
            }
            if (!aChunks.length) aChunks.push([]);

            aChunks.forEach(function (aChunk, idx) {
                var oTableSlide = pptx.addSlide();
                oTableSlide.addText("Executions" + (aChunks.length > 1 ? " (" + (idx + 1) + "/" + aChunks.length + ")" : ""),
                    { x: 0.3, y: 0.2, w: 9.4, h: 0.4, fontSize: 16, bold: true });
                if (aChunk.length) {
                    oTableSlide.addTable([aHeaderRow].concat(aChunk), {
                        x: 0.3, y: 0.7, w: 9.4,
                        fontSize: 9,
                        color: "333333",
                        border: { type: "solid", color: "CFCFCF", pt: 0.5 }
                    });
                } else {
                    oTableSlide.addText("No executions to show.", { x: 0.3, y: 0.8, w: 9, h: 0.5, fontSize: 12, italic: true });
                }
            });

            var sSafeName = String(sProjectName).replace(/[^a-z0-9]+/gi, "_");
            pptx.writeFile({ fileName: sSafeName + "_export.pptx" });
        }
    });
});
