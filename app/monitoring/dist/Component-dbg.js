sap.ui.define([
    "sap/ui/core/UIComponent",
    "sap/ui/model/json/JSONModel",
    "sap/ui/Device",
    "sap/m/BusyDialog"
], function (UIComponent, JSONModel, Device, BusyDialog) {
    "use strict";

    return UIComponent.extend("monitoring.Component", {
        metadata: {
            manifest: "json"
        },

        init: function () {
            // Call the base component's init function
            UIComponent.prototype.init.apply(this, arguments);

            // Set device model
            var oDeviceModel = new JSONModel(Device);
            oDeviceModel.setDefaultBindingMode("OneWay");
            this.setModel(oDeviceModel, "device");

            // Initialize monitoring model
            this._initMonitoringModel();

            // Initialize the router
            this.getRouter().initialize();
        },

        /**
         * Show or hide the global BusyDialog
         * @param {boolean} bBusy
         */
        _setBusy: function (bBusy) {
            if (bBusy) {
                if (!this._oBusyDialog) {
                    this._oBusyDialog = new BusyDialog();
                }
                this._oBusyDialog.open();
            } else {
                if (this._oBusyDialog) {
                    this._oBusyDialog.close();
                }
            }
        },

        /**
         * Initialize the monitoring model from OData backend
         */
        _initMonitoringModel: function () {
            var oMonitoringModel = new JSONModel({
                projects: [],
                filteredProjects: [],
                selectedProject: null,
                executions: [],
                taskChains: [],
                alerts: []
            });
            this.setModel(oMonitoringModel, "monitoring");

            // Load projects from OData
            this._setBusy(true);
            this._loadProjectsFromOData();
        },

        /**
         * Load projects from OData backend
         */
        _loadProjectsFromOData: function () {
            var oODataModel = this.getModel(); // Default model is OData
            var oMonitoringModel = this.getModel("monitoring");
            var that = this;

            // Use OData V4 list binding to read projects
            var oListBinding = oODataModel.bindList("/MonitoringProject", undefined, undefined, undefined, {
                $expand: "taskChains"
            });

            return oListBinding.requestContexts(0, 100).then(function (aContexts) {
                var aProjects = aContexts.map(function (oContext) {
                    var oData = oContext.getObject();
                    // Map OData entity to our internal format
                    return {
                        id: oData.ID,
                        name: oData.name,
                        description: oData.description,
                        status: oData.status,
                        slaTarget: oData.slaTarget,
                        alertThreshold: oData.alertThreshold,
                        taskChainsList: (oData.taskChains || []).map(function (tc) {
                            return {
                                id: tc.ID,
                                name: tc.chainName,
                                spaceId: tc.spaceId,
                                description: tc.description,
                                version: tc.version,
                                status: tc.status,
                                slaTarget: tc.slaTarget
                            };
                        }),
                        // These will be calculated from real data
                        successRate: 100,
                        errorsLast24h: 0,
                        avgDurationP95: 0,
                        taskChains: (oData.taskChains || []).length
                    };
                });

                oMonitoringModel.setProperty("/projects", aProjects);
                oMonitoringModel.setProperty("/filteredProjects", aProjects);
                that._setBusy(false);
            }).catch(function (oError) {
                console.error("Error loading projects from OData:", oError);
                that._setBusy(false);
            });
        },

        /**
         * Refresh projects from OData
         */
        refreshProjects: function () {
            this._setBusy(true);
            return this._loadProjectsFromOData();
        },

        /**
         * Create a new project in the OData backend
         * @param {object} oProjectData - The project data
         * @returns {Promise} Promise resolving to the created project
         */
        createProject: function (oProjectData) {
            var oODataModel = this.getModel();
            var oMonitoringModel = this.getModel("monitoring");
            var that = this;

            var oListBinding = oODataModel.bindList("/MonitoringProject");
            var oContext = oListBinding.create({
                name: oProjectData.name,
                description: oProjectData.description || "",
                status: "Active",
                slaTarget: oProjectData.slaTarget || 99.0,
                alertThreshold: oProjectData.alertThreshold || 5
            });

            return oContext.created().then(function () {
                // Refresh projects after creation
                that.refreshProjects();
                return oContext.getObject();
            });
        },

        /**
         * Delete a project from the OData backend
         * @param {string} sProjectId - The project ID to delete
         * @returns {Promise} Promise resolving when deleted
         */
        deleteProject: function (sProjectId) {
            var oODataModel = this.getModel();
            var that = this;

            // Get the context for this project
            return new Promise(function (resolve, reject) {
                var oListBinding = oODataModel.bindList("/MonitoringProject", undefined, undefined, undefined, {
                    $filter: "ID eq " + sProjectId
                });
                
                oListBinding.requestContexts(0, 1).then(function (aContexts) {
                    if (aContexts.length > 0) {
                        aContexts[0].delete().then(function () {
                            that.refreshProjects();
                            resolve();
                        }).catch(reject);
                    } else {
                        reject(new Error("Project not found"));
                    }
                }).catch(reject);
            });
        },

        /**
         * Add a task chain to a project
         * @param {string} sProjectId - The project ID
         * @param {object} oTaskChainData - The task chain data
         * @returns {Promise} Promise resolving to the created task chain
         */
        addTaskChain: function (sProjectId, oTaskChainData) {
            var oODataModel = this.getModel();
            var that = this;

            var oListBinding = oODataModel.bindList("/MonitoringTaskChain");
            var oContext = oListBinding.create({
                project_ID: sProjectId,
                chainName: oTaskChainData.name,
                spaceId: oTaskChainData.spaceId || "",
                description: oTaskChainData.description || "",
                version: oTaskChainData.version || "1.0",
                status: "Active",
                slaTarget: oTaskChainData.slaTarget || 99.0
            });

            return oContext.created().then(function () {
                return that.refreshProjects().then(function() {
                    return oContext.getObject();
                });
            });
        },

        /**
         * Remove a task chain from a project
         * @param {string} sTaskChainId - The task chain ID to delete
         * @returns {Promise} Promise resolving when deleted
         */
        removeTaskChain: function (sTaskChainId) {
            var oODataModel = this.getModel();
            var sFilter = "ID eq " + sTaskChainId;
            var that = this;

            return new Promise(function (resolve, reject) {
                var oListBinding = oODataModel.bindList("/MonitoringTaskChain", undefined, undefined, undefined, {
                    $filter: sFilter
                });

                oListBinding.requestContexts(0, 1).then(function (aContexts) {
                    if (aContexts.length > 0) {
                        aContexts[0].delete().then(function () {
                            that.refreshProjects().then(function() {
                                resolve();
                            }).catch(function(oErr) {
                                reject(oErr);
                            });
                        }).catch(function(oErr) {
                            reject(oErr);
                        });
                    } else {
                        reject(new Error("Task chain not found"));
                    }
                }).catch(function(oErr) {
                    reject(oErr);
                });
            });
        },

        /**
         * Save projects - now a no-op since we use OData
         * @deprecated Use createProject/deleteProject instead
         */
        saveProjects: function () {
            // No-op - OData handles persistence
            console.log("saveProjects is deprecated, using OData persistence");
        },

        getContentDensityClass: function () {
            if (this._sContentDensityClass === undefined) {
                if (document.body.classList.contains("sapUiSizeCozy") || document.body.classList.contains("sapUiSizeCompact")) {
                    this._sContentDensityClass = "";
                } else if (!Device.support.touch) {
                    this._sContentDensityClass = "sapUiSizeCompact";
                } else {
                    this._sContentDensityClass = "sapUiSizeCozy";
                }
            }
            return this._sContentDensityClass;
        }
    });
});
