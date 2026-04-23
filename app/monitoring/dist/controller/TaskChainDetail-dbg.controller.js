sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/ui/core/routing/History"
], function (Controller, JSONModel, MessageToast, History) {
    "use strict";

    return Controller.extend("monitoring.controller.TaskChainDetail", {
        
        onInit: function () {
            var oRouter = this.getOwnerComponent().getRouter();
            oRouter.getRoute("taskChainDetail").attachPatternMatched(this._onRouteMatched, this);
        },

        /**
         * Called when the route pattern is matched
         * @param {sap.ui.base.Event} oEvent - The route matched event
         */
        _onRouteMatched: function (oEvent) {
            var oArgs = oEvent.getParameter("arguments");
            this._sProjectId = oArgs.projectId;
            this._sChainId = oArgs.chainId;
            this._loadChainData();
        },

        /**
         * Load task chain data
         */
        _loadChainData: function () {
            var oView = this.getView();
            var sChainId = decodeURIComponent(this._sChainId);
            
            // Get project data from the OData-backed monitoring model
            var oMonitoringModel = this.getOwnerComponent().getModel("monitoring");
            var aProjects = (oMonitoringModel && oMonitoringModel.getProperty("/projects")) || [];
            var oProject = aProjects.find(function(p) { return p.id === this._sProjectId; }.bind(this));
            var sSpaceId = "";
            var sChainName = sChainId;
            
            if (oProject && oProject.taskChainsList) {
                var oChain = oProject.taskChainsList.find(function(tc) { 
                    return tc.name === sChainId || tc.id === sChainId; 
                });
                if (oChain) {
                    sSpaceId = oChain.spaceId || "";
                    sChainName = oChain.name || sChainId;
                }
            }
            
            // Create initial model
            var oChainDetailModel = new JSONModel({
                chainId: sChainId,
                chainName: sChainName,
                spaceId: sSpaceId,
                version: "v1.0",
                status: "loading",
                statusText: "Loading...",
                useSvgDag: false,
                nodes: [],
                executions: [],
                dagHtml: ""
            });
            
            oView.setModel(oChainDetailModel, "chainDetail");
            
            // Use chain name for DSP API (DSP uses name, not UUID)
            var sApiChainId = sChainName || sChainId;
            
            // Load execution history first (it can provide spaceId if missing)
            this._loadExecutionHistory(sApiChainId, sSpaceId, oChainDetailModel);
            
            // Load DAG - if spaceId is empty, wait for execution history
            if (sSpaceId) {
                this._loadDagStructure(sApiChainId, sSpaceId, oChainDetailModel);
            }
            // Otherwise, _loadExecutionHistory will call _loadDagStructure after finding spaceId
        },
        
        /**
         * Load DAG structure from DSP API
         */
        _loadDagStructure: function(sChainId, sSpaceId, oModel) {
            if (!sSpaceId) {
                console.warn("Cannot load DAG: spaceId is empty");
                return;
            }
            
            var sBaseUrl = this._getPySrvUrl();
            var sUrl = sBaseUrl + "/v1/dsp/taskchain-dag?spaceId=" + encodeURIComponent(sSpaceId) + 
                       "&taskchain=" + encodeURIComponent(sChainId);
            
            this._fetchDsp(sUrl)
                .then(function(response) { return response.json(); })
                .then(function(result) {
                    if (result.success) {
                        // Generate SVG from real DAG data
                        var sSvg = this._generateDagSvgFromData(result.nodes, result.links);
                        oModel.setProperty("/dagHtml", sSvg);
                        oModel.setProperty("/useSvgDag", true);
                        
                        // Also store nodes for the box-based fallback
                        oModel.setProperty("/nodes", result.nodes);
                        oModel.setProperty("/links", result.links);
                    }
                }.bind(this))
                .catch(function(error) {
                    console.error("Error loading DAG structure:", error);
                });
        },
        
        /**
         * Generate SVG from real DAG data
         */
        _generateDagSvgFromData: function(aNodes, aLinks) {
            if (!aNodes || aNodes.length === 0) {
                return '<svg width="800" height="100"><text x="400" y="50" text-anchor="middle" fill="#666">No DAG data available</text></svg>';
            }
            
            // Calculate layout - organize nodes by levels (BFS from START)
            var oLevels = this._calculateDagLevels(aNodes, aLinks);
            var iMaxLevel = Math.max.apply(null, Object.values(oLevels));
            var aNodesPerLevel = [];
            for (var i = 0; i <= iMaxLevel; i++) {
                aNodesPerLevel[i] = aNodes.filter(function(n) { return oLevels[n.id] === i; });
            }
            
            // SVG dimensions
            var iNodeWidth = 140;
            var iNodeHeight = 40;
            var iLevelSpacing = 180;
            var iNodeSpacing = 60;
            var iPadding = 40;
            
            var iMaxNodesInLevel = Math.max.apply(null, aNodesPerLevel.map(function(l) { return l.length; }));
            var iSvgWidth = (iMaxLevel + 1) * iLevelSpacing + iPadding * 2;
            var iSvgHeight = Math.max(300, iMaxNodesInLevel * (iNodeHeight + iNodeSpacing) + iPadding * 2);
            
            var aSvgParts = [];
            aSvgParts.push('<svg width="' + iSvgWidth + '" height="' + iSvgHeight + '" xmlns="http://www.w3.org/2000/svg">');
            aSvgParts.push('<style>');
            aSvgParts.push('.node-success { fill: #107e3e; }');
            aSvgParts.push('.node-error { fill: #bb0000; }');
            aSvgParts.push('.node-running { fill: #0854a0; }');
            aSvgParts.push('.node-pending { fill: #6a6d70; }');
            aSvgParts.push('.node-start { fill: #0854a0; }');
            aSvgParts.push('.node-text { fill: white; font-size: 11px; font-family: "72", Arial, sans-serif; }');
            aSvgParts.push('.edge { stroke: #6a6d70; stroke-width: 2; fill: none; marker-end: url(#arrowhead); }');
            aSvgParts.push('</style>');
            aSvgParts.push('<defs>');
            aSvgParts.push('<marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">');
            aSvgParts.push('<polygon points="0 0, 10 3.5, 0 7" fill="#6a6d70"/>');
            aSvgParts.push('</marker>');
            aSvgParts.push('</defs>');
            
            // Calculate node positions
            var oNodePositions = {};
            for (var level = 0; level <= iMaxLevel; level++) {
                var aLevelNodes = aNodesPerLevel[level];
                var iLevelHeight = aLevelNodes.length * (iNodeHeight + iNodeSpacing) - iNodeSpacing;
                var iStartY = (iSvgHeight - iLevelHeight) / 2;
                
                aLevelNodes.forEach(function(node, idx) {
                    var x = iPadding + level * iLevelSpacing;
                    var y = iStartY + idx * (iNodeHeight + iNodeSpacing);
                    oNodePositions[node.id] = { x: x, y: y };
                });
            }
            
            // Draw edges first (so they're behind nodes)
            aLinks.forEach(function(link) {
                var fromPos = oNodePositions[link.from];
                var toPos = oNodePositions[link.to];
                if (fromPos && toPos) {
                    var x1 = fromPos.x + iNodeWidth;
                    var y1 = fromPos.y + iNodeHeight / 2;
                    var x2 = toPos.x;
                    var y2 = toPos.y + iNodeHeight / 2;
                    
                    // Draw curved path
                    var midX = (x1 + x2) / 2;
                    aSvgParts.push('<path class="edge" d="M ' + x1 + ' ' + y1 + ' C ' + midX + ' ' + y1 + ', ' + midX + ' ' + y2 + ', ' + x2 + ' ' + y2 + '"/>');
                }
            });
            
            // Draw nodes
            aNodes.forEach(function(node) {
                var pos = oNodePositions[node.id];
                if (!pos) return;
                
                var sClass = "node-pending";
                if (node.type === "START") {
                    sClass = "node-start";
                } else if (node.status === "success") {
                    sClass = "node-success";
                } else if (node.status === "error") {
                    sClass = "node-error";
                } else if (node.status === "running") {
                    sClass = "node-running";
                }
                
                // Node rectangle
                aSvgParts.push('<rect class="' + sClass + '" x="' + pos.x + '" y="' + pos.y + '" width="' + iNodeWidth + '" height="' + iNodeHeight + '" rx="5"/>');
                
                // Node label
                var sLabel = node.type === "START" ? "START" : (node.objectId || "Task " + node.id);
                if (sLabel.length > 18) {
                    sLabel = sLabel.substring(0, 16) + "...";
                }
                aSvgParts.push('<text class="node-text" x="' + (pos.x + iNodeWidth / 2) + '" y="' + (pos.y + iNodeHeight / 2 + 4) + '" text-anchor="middle">' + sLabel + '</text>');
                
                // Status icon (small circle)
                if (node.type !== "START") {
                    var sIconColor = node.status === "success" ? "#fff" : node.status === "error" ? "#fff" : "#ccc";
                    var sIcon = node.status === "success" ? "✓" : node.status === "error" ? "✗" : "○";
                    aSvgParts.push('<text x="' + (pos.x + 10) + '" y="' + (pos.y + iNodeHeight / 2 + 4) + '" fill="' + sIconColor + '" font-size="12">' + sIcon + '</text>');
                }
            });
            
            aSvgParts.push('</svg>');
            return aSvgParts.join('');
        },
        
        /**
         * Calculate levels for DAG layout using BFS
         */
        _calculateDagLevels: function(aNodes, aLinks) {
            var oLevels = {};
            var oChildren = {};
            
            // Build adjacency list
            aNodes.forEach(function(n) {
                oChildren[n.id] = [];
                oLevels[n.id] = -1;
            });
            aLinks.forEach(function(l) {
                if (oChildren[l.from]) {
                    oChildren[l.from].push(l.to);
                }
            });
            
            // Find START node
            var startNode = aNodes.find(function(n) { return n.type === "START"; });
            if (!startNode) {
                // No START node, use node with no incoming edges
                var hasIncoming = {};
                aLinks.forEach(function(l) { hasIncoming[l.to] = true; });
                startNode = aNodes.find(function(n) { return !hasIncoming[n.id]; }) || aNodes[0];
            }
            
            // BFS to assign levels
            var queue = [startNode.id];
            oLevels[startNode.id] = 0;
            
            while (queue.length > 0) {
                var nodeId = queue.shift();
                var nextLevel = oLevels[nodeId] + 1;
                
                (oChildren[nodeId] || []).forEach(function(childId) {
                    if (oLevels[childId] < nextLevel) {
                        oLevels[childId] = nextLevel;
                        queue.push(childId);
                    }
                });
            }
            
            // Handle disconnected nodes
            aNodes.forEach(function(n) {
                if (oLevels[n.id] === -1) {
                    oLevels[n.id] = 0;
                }
            });
            
            return oLevels;
        },
        
        /**
         * Load execution history from DSP API
         */
        _loadExecutionHistory: function(sChainId, sSpaceId, oModel) {
            var sBaseUrl = this._getPySrvUrl();
            // If spaceId is empty, just query by taskchain name
            var sUrl = sBaseUrl + "/v1/dsp/taskchain-runs?taskchain=" + encodeURIComponent(sChainId) + 
                       "&limit=800";
            if (sSpaceId) {
                sUrl += "&spaceId=" + encodeURIComponent(sSpaceId);
            }
            
            this._fetchDsp(sUrl)
                .then(function(response) { return response.json(); })
                .then(function(result) {
                    if (result.success && result.runs) {
                        var aRuns = result.runs;
                        
                        // Extract spaceId from first run if not already set
                        var sFoundSpaceId = oModel.getProperty("/spaceId");
                        if (!sFoundSpaceId && aRuns.length > 0 && aRuns[0].spaceId) {
                            sFoundSpaceId = aRuns[0].spaceId;
                            oModel.setProperty("/spaceId", sFoundSpaceId);
                            
                            // Now load DAG with the discovered spaceId
                            this._loadDagStructure(sChainId, sFoundSpaceId, oModel);
                        }
                        
                        // Calculate status based on most recent run
                        var sStatus = "success";
                        var sStatusText = "Completed";
                        if (aRuns.length > 0) {
                            var latestRun = aRuns[0];
                            sStatus = latestRun.status;
                            sStatusText = sStatus === "success" ? "Completed" : 
                                         sStatus === "error" ? "Failed" : 
                                         sStatus === "running" ? "Running" : "Pending";
                        }
                        
                        // Map runs to execution format
                        var aExecutions = aRuns.map(function(run) {
                            return {
                                runId: run.runId,
                                taskName: run.taskChain,
                                status: run.status,
                                statusText: run.status === "success" ? "Success" : 
                                           run.status === "error" ? "Error" : 
                                           run.status === "running" ? "Running" : "Pending",
                                startTime: run.startTime,
                                duration: run.durationDisplay || run.duration || "-",
                                retries: 0
                            };
                        });
                        
                        oModel.setProperty("/status", sStatus);
                        oModel.setProperty("/statusText", sStatusText);
                        oModel.setProperty("/executions", aExecutions);
                    }
                }.bind(this))
                .catch(function(error) {
                    console.error("Error loading execution history:", error);
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
            console.log("[DSP ChainDetail] fetch →", sUrl);
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
                this.getOwnerComponent().getRouter().navTo("projectDashboard", {
                    projectId: this._sProjectId
                }, true);
            }
        },

        /**
         * Handle DAG node press for drill-down
         * @param {sap.ui.base.Event} oEvent - The press event
         */
        onDagNodePress: function (oEvent) {
            var oButton = oEvent.getSource();
            var sNodeName = oButton.getText();
            MessageToast.show("Node clicked: " + sNodeName);
            // TODO: Open node detail popover or navigate to task detail
        },

        /**
         * Navigate to run inspector
         * @param {sap.ui.base.Event} oEvent - The press event
         */
        onRunIdPress: function (oEvent) {
            var oBindingContext = oEvent.getSource().getBindingContext("chainDetail");
            var sRunId = oBindingContext.getProperty("runId");
            
            this.getOwnerComponent().getRouter().navTo("runInspector", {
                projectId: this._sProjectId,
                chainId: this._sChainId,
                runId: sRunId
            });
        },

        /**
         * Handle execution row press
         * @param {sap.ui.base.Event} oEvent - The press event
         */
        onExecutionRowPress: function (oEvent) {
            var oBindingContext = oEvent.getSource().getBindingContext("chainDetail");
            var sRunId = oBindingContext.getProperty("runId");
            
            this.getOwnerComponent().getRouter().navTo("runInspector", {
                projectId: this._sProjectId,
                chainId: this._sChainId,
                runId: sRunId
            });
        }
    });
});
