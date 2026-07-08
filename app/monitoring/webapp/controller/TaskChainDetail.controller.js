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
                dagLoading: true,
                nodes: [],
                executions: [],
                dagHtml: ""
            });
            
            oView.setModel(oChainDetailModel, "chainDetail");
            
            // Use chain name for DSP API (DSP uses name, not UUID)
            var sApiChainId = sChainName || sChainId;
            
            // Load execution history first (it can provide spaceId if missing)
            this.getOwnerComponent()._setBusy(true);
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
                    oModel.setProperty("/dagLoading", false);
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
                    oModel.setProperty("/dagLoading", false);
                    console.error("Error loading DAG structure:", error);
                });
        },
        
        /**
         * Generate SVG from real DAG data
         */
        _generateDagSvgFromData: function(aNodes, aLinks) {
            if (!aNodes || aNodes.length === 0) {
                return '<svg width="400" height="60"><text x="200" y="35" text-anchor="middle" fill="#6a6d70" font-size="13" font-family="Arial,sans-serif">No DAG data available</text></svg>';
            }

            // Layout constants — left-to-right
            var NW = 165;   // node width
            var NH = 58;    // node height
            var H_GAP = 55; // horizontal gap between levels
            var V_GAP = 20; // vertical gap between nodes in same level
            var PAD_Y = 30;
            var PAD_LEFT = 30;
            var BEGIN_W = 52; // space reserved for Begin circle + gap

            // Separate START node from regular nodes
            var oStartNode = aNodes.find(function(n) { return n.type === "START"; });
            var aRegular = aNodes.filter(function(n) { return n.type !== "START"; });

            // BFS levels
            var oLevels = this._calculateDagLevels(aNodes, aLinks);
            if (oStartNode) {
                aRegular.forEach(function(n) { oLevels[n.id] = oLevels[n.id] - 1; });
            }

            var iMaxLevel = aRegular.length > 0
                ? Math.max.apply(null, aRegular.map(function(n) { return oLevels[n.id] || 0; }))
                : 0;

            // Group by level
            var aByLevel = [];
            for (var i = 0; i <= iMaxLevel; i++) {
                aByLevel[i] = aRegular.filter(function(n) { return (oLevels[n.id] || 0) === i; });
            }

            // Canvas size (left-to-right)
            var iMaxRows = Math.max.apply(null, aByLevel.map(function(a) { return a.length; })) || 1;
            var iSvgW = PAD_LEFT + BEGIN_W + (iMaxLevel + 1) * (NW + H_GAP) + PAD_LEFT;
            var iSvgH = Math.max(NH + PAD_Y * 2, iMaxRows * NH + (iMaxRows - 1) * V_GAP + PAD_Y * 2);

            // Node positions: level → X, position within level → Y (centered)
            var oPos = {};
            aByLevel.forEach(function(aLevel, iLvl) {
                var iColH = aLevel.length * NH + (aLevel.length - 1) * V_GAP;
                var iStartY = (iSvgH - iColH) / 2;
                aLevel.forEach(function(n, iRow) {
                    oPos[n.id] = {
                        x: PAD_LEFT + BEGIN_W + iLvl * (NW + H_GAP),
                        y: iStartY + iRow * (NH + V_GAP)
                    };
                });
            });

            var p = [];

            p.push('<svg width="' + iSvgW + '" height="' + iSvgH + '" xmlns="http://www.w3.org/2000/svg">');
            p.push('<style>');
            p.push('.dn-title{font:bold 11px "72",Arial,sans-serif}');
            p.push('.dn-sub{font:10px "72",Arial,sans-serif;fill:#6a6d70}');
            p.push('.dn-begin{font:11px "72",Arial,sans-serif;fill:#1d2d3e;text-anchor:middle}');
            p.push('</style>');
            p.push('<defs>');
            p.push('<marker id="arr" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">');
            p.push('<polygon points="0,0 7,3.5 0,7" fill="#1473e6"/>');
            p.push('</marker>');
            p.push('</defs>');

            // BEGIN circle (vertically centered, on the left)
            var iBR = 16;
            var iBX = PAD_LEFT + iBR;
            var iBY = iSvgH / 2;
            p.push('<circle cx="' + iBX + '" cy="' + iBY + '" r="' + iBR + '" fill="white" stroke="#1473e6" stroke-width="1.5"/>');
            p.push('<polygon points="' + (iBX - 5) + ',' + (iBY - 7) + ' ' + (iBX - 5) + ',' + (iBY + 7) + ' ' + (iBX + 8) + ',' + iBY + '" fill="#1473e6"/>');
            p.push('<text x="' + iBX + '" y="' + (iBY + iBR + 13) + '" class="dn-begin">Begin</text>');

            // Edges from BEGIN to level-0 nodes
            if (aByLevel[0]) {
                aByLevel[0].forEach(function(n) {
                    var op = oPos[n.id];
                    var x1 = iBX + iBR, y1 = iBY;
                    var x2 = op.x,      y2 = op.y + NH / 2;
                    var mX = (x1 + x2) / 2;
                    p.push('<path d="M' + x1 + ',' + y1 + ' L' + mX + ',' + y1 + ' L' + mX + ',' + y2 + ' L' + (x2 - 5) + ',' + y2 + '" stroke="#1473e6" stroke-width="1.5" fill="none" marker-end="url(#arr)"/>');
                });
            }

            // Edges between regular nodes
            aLinks.forEach(function(lnk) {
                var fp = oPos[lnk.from], tp = oPos[lnk.to];
                if (!fp || !tp) return;
                var x1 = fp.x + NW,       y1 = fp.y + NH / 2;
                var x2 = tp.x,             y2 = tp.y + NH / 2;
                var mX = (x1 + x2) / 2;
                p.push('<path d="M' + x1 + ',' + y1 + ' L' + mX + ',' + y1 + ' L' + mX + ',' + y2 + ' L' + (x2 - 5) + ',' + y2 + '" stroke="#1473e6" stroke-width="1.5" fill="none" marker-end="url(#arr)"/>');
            });

            // Node cards
            var that = this;
            var STRIP_W = 34; // icon strip width
            aRegular.forEach(function(n) {
                var op = oPos[n.id];
                if (!op) return;
                var x = op.x, y = op.y;
                var cx = x + STRIP_W / 2; // icon center X
                var cy = y + NH / 2;      // icon center Y

                // Border + strip colours by status
                var sBorder = n.status === "error" ? "#bb0000" : n.status === "running" ? "#e9730c" : "#1473e6";
                var sStrip  = n.status === "error" ? "#fff0f0" : n.status === "running" ? "#fff4eb" : "#eaf3ff";

                // Card white background + border (uniform 1.5px)
                p.push('<rect x="' + x + '" y="' + y + '" width="' + NW + '" height="' + NH + '" rx="4" fill="white" stroke="' + sBorder + '" stroke-width="1.5"/>');

                // Icon strip (tinted, inset 2px so card border shows around all edges)
                p.push('<rect x="' + (x + 2) + '" y="' + (y + 2) + '" width="' + (STRIP_W - 2) + '" height="' + (NH - 4) + '" fill="' + sStrip + '"/>');

                // Divider line between strip and text area
                p.push('<line x1="' + (x + STRIP_W) + '" y1="' + (y + 1) + '" x2="' + (x + STRIP_W) + '" y2="' + (y + NH - 1) + '" stroke="' + sBorder + '" stroke-width="1"/>');

                // Type icon (geometric, centred in strip)
                var sType = (n.taskType || n.type || "").toLowerCase();
                if (sType.indexOf("chain") !== -1) {
                    // Chain: two linked rects
                    p.push('<rect x="' + (cx - 10) + '" y="' + (cy - 5) + '" width="8" height="10" rx="1.5" fill="none" stroke="' + sBorder + '" stroke-width="1.5"/>');
                    p.push('<rect x="' + (cx + 2)  + '" y="' + (cy - 5) + '" width="8" height="10" rx="1.5" fill="none" stroke="' + sBorder + '" stroke-width="1.5"/>');
                    p.push('<line x1="' + (cx - 2) + '" y1="' + cy + '" x2="' + (cx + 2) + '" y2="' + cy + '" stroke="' + sBorder + '" stroke-width="2"/>');
                } else if (sType.indexOf("api") !== -1) {
                    // API: three horizontal lines (endpoint list)
                    p.push('<line x1="' + (cx - 8) + '" y1="' + (cy - 5) + '" x2="' + (cx + 8) + '" y2="' + (cy - 5) + '" stroke="' + sBorder + '" stroke-width="2" stroke-linecap="round"/>');
                    p.push('<line x1="' + (cx - 8) + '" y1="' + cy      + '" x2="' + (cx + 8) + '" y2="' + cy      + '" stroke="' + sBorder + '" stroke-width="2" stroke-linecap="round"/>');
                    p.push('<line x1="' + (cx - 8) + '" y1="' + (cy + 5) + '" x2="' + (cx + 8) + '" y2="' + (cy + 5) + '" stroke="' + sBorder + '" stroke-width="2" stroke-linecap="round"/>');
                } else if (sType.indexOf("transform") !== -1 || sType.indexOf("flow") !== -1) {
                    // Transformation / Flow: diamond
                    p.push('<polygon points="' + cx + ',' + (cy - 9) + ' ' + (cx + 9) + ',' + cy + ' ' + cx + ',' + (cy + 9) + ' ' + (cx - 9) + ',' + cy + '" fill="none" stroke="' + sBorder + '" stroke-width="1.5"/>');
                } else {
                    // Default / TASK: document icon (rect + two text lines)
                    p.push('<rect x="' + (cx - 6) + '" y="' + (cy - 8) + '" width="12" height="16" rx="1.5" fill="none" stroke="' + sBorder + '" stroke-width="1.5"/>');
                    p.push('<line x1="' + (cx - 3) + '" y1="' + (cy - 3) + '" x2="' + (cx + 3) + '" y2="' + (cy - 3) + '" stroke="' + sBorder + '" stroke-width="1.5" stroke-linecap="round"/>');
                    p.push('<line x1="' + (cx - 3) + '" y1="' + (cy + 2) + '" x2="' + (cx + 3) + '" y2="' + (cy + 2) + '" stroke="' + sBorder + '" stroke-width="1.5" stroke-linecap="round"/>');
                }

                // Clip text to the card's text area (right of strip, inside border)
                var sClipId = "clip_" + n.id.toString().replace(/[^a-zA-Z0-9_]/g, "_");
                var iTextX = x + STRIP_W + 2;
                var iTextW = NW - STRIP_W - 6;
                p.push('<clipPath id="' + sClipId + '"><rect x="' + iTextX + '" y="' + y + '" width="' + iTextW + '" height="' + NH + '"/></clipPath>');

                // Title + subtitle wrapped in a <g> with tooltip
                var sName = n.objectId || n.name || ("Node " + n.id);
                var sSub = (n.taskType || n.type || "");
                var sTooltip = sName + (sSub ? " (" + sSub + ")" : "");
                p.push('<g>');
                p.push('<title>' + that._escapeXml(sTooltip) + '</title>');
                p.push('<text x="' + (x + STRIP_W + 10) + '" y="' + (y + 22) + '" class="dn-title" fill="' + sBorder + '" clip-path="url(#' + sClipId + ')">' + that._escapeXml(sName) + '</text>');
                if (sSub) {
                    p.push('<text x="' + (x + STRIP_W + 10) + '" y="' + (y + 38) + '" class="dn-sub" clip-path="url(#' + sClipId + ')">' + that._escapeXml(sSub) + '</text>');
                }
                p.push('</g>');
            });

            p.push('</svg>');
            return p.join('');
        },

        _escapeXml: function(s) {
            if (!s) return '';
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
                        } else if (!oModel.getProperty("/spaceId")) {
                            // No spaceId found anywhere — DAG will never load
                            oModel.setProperty("/dagLoading", false);
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
                    this.getOwnerComponent()._setBusy(false);
                }.bind(this))
                .catch(function(error) {
                    console.error("Error loading execution history:", error);
                    if (!oModel.getProperty("/spaceId")) {
                        oModel.setProperty("/dagLoading", false);
                    }
                    this.getOwnerComponent()._setBusy(false);
                }.bind(this));
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
         * Refresh chain detail data
         */
        onRefresh: function () {
            this._loadChainData();
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
