sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment"
], function (Controller, JSONModel, MessageToast, MessageBox, Fragment) {
    "use strict";

    return Controller.extend("monitoring.controller.ProjectList", {
        
        onInit: function () {
            // Initialize new project model for the dialog
            this._oNewProjectModel = new JSONModel({
                name: "",
                description: ""
            });

            // Initialize filter state
            this._sSearchQuery = "";

            // Initialize filtered projects when view is ready
            this.getView().addEventDelegate({
                onAfterShow: this._initFilteredProjects.bind(this)
            });

            // Also listen for model changes
            var oRouter = this.getOwnerComponent().getRouter();
            oRouter.getRoute("projectList").attachPatternMatched(this._onRouteMatched, this);
        },

        /**
         * Handle route matched
         */
        _onRouteMatched: function () {
            // Reset search and refresh
            this._sSearchQuery = "";
            
            // Reset UI controls if view is rendered
            var oSearchField = this.byId("projectSearchField");
            if (oSearchField) {
                oSearchField.setValue("");
            }
            
            this._initFilteredProjects();
        },

        /**
         * Navigate to project dashboard when a project row is pressed
         * @param {sap.ui.base.Event} oEvent - The press event
         */
        onProjectPress: function (oEvent) {
            var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
            var oBindingContext = oItem.getBindingContext("monitoring");
            var sProjectId = oBindingContext.getProperty("id");
            
            this.getOwnerComponent().getRouter().navTo("projectDashboard", {
                projectId: sProjectId
            });
        },

        /**
         * Open dialog to create a new monitoring project
         */
        onNewProject: function () {
            var oView = this.getView();
            
            // Reset the model
            this._oNewProjectModel.setData({
                name: "",
                description: ""
            });

            if (!this._pCreateDialog) {
                this._pCreateDialog = Fragment.load({
                    id: oView.getId(),
                    name: "monitoring.view.fragments.CreateProjectDialog",
                    controller: this
                }).then(function (oDialog) {
                    oView.addDependent(oDialog);
                    oDialog.setModel(this._oNewProjectModel, "newProject");
                    return oDialog;
                }.bind(this));
            }

            this._pCreateDialog.then(function (oDialog) {
                oDialog.open();
            });
        },

        /**
         * Handle create project confirmation
         */
        onCreateProjectConfirm: function () {
            var oData = this._oNewProjectModel.getData();
            var oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            var that = this;

            // Validation
            if (!oData.name || oData.name.trim() === "") {
                MessageBox.error(oResourceBundle.getText("projectList.validationError"));
                return;
            }

            // Create project via OData
            this.getOwnerComponent().createProject({
                name: oData.name.trim(),
                description: oData.description ? oData.description.trim() : ""
            }).then(function () {
                // Close dialog and show success message
                that._closeCreateDialog();
                MessageToast.show(oResourceBundle.getText("projectList.created", [oData.name]));
            }).catch(function (oError) {
                MessageBox.error("Error creating project: " + oError.message);
            });
        },

        /**
         * Handle create project cancel
         */
        onCreateProjectCancel: function () {
            this._closeCreateDialog();
        },

        /**
         * Close the create project dialog
         */
        _closeCreateDialog: function () {
            this._pCreateDialog.then(function (oDialog) {
                oDialog.close();
            });
        },

        /**
         * Refresh the project list
         */
        onRefresh: function () {
            MessageToast.show("Refreshing projects...");
            this.getOwnerComponent().refreshProjects();
        },

        /**
         * Handle search input
         * @param {sap.ui.base.Event} oEvent - The liveChange event
         */
        onSearchProjects: function (oEvent) {
            this._sSearchQuery = oEvent.getParameter("newValue").toLowerCase();
            this._applyFilters();
        },

        /**
         * Apply search filter to projects
         */
        _applyFilters: function () {
            var oMonitoringModel = this.getOwnerComponent().getModel("monitoring");
            var aProjects = oMonitoringModel.getProperty("/projects") || [];
            var sSearch = this._sSearchQuery || "";

            var aFiltered = aProjects.filter(function (oProject) {
                // Search filter
                return !sSearch ||
                    (oProject.name && oProject.name.toLowerCase().indexOf(sSearch) !== -1) ||
                    (oProject.description && oProject.description.toLowerCase().indexOf(sSearch) !== -1);
            });

            oMonitoringModel.setProperty("/filteredProjects", aFiltered);
        },

        /**
         * Initialize filtered projects when model changes
         */
        _initFilteredProjects: function () {
            var oMonitoringModel = this.getOwnerComponent().getModel("monitoring");
            var aProjects = oMonitoringModel.getProperty("/projects") || [];
            oMonitoringModel.setProperty("/filteredProjects", aProjects);
        },

        /**
         * Delete a project
         * @param {sap.ui.base.Event} oEvent - The press event
         */
        onDeleteProject: function (oEvent) {
            var oButton = oEvent.getSource();
            var oBindingContext = oButton.getBindingContext("monitoring");
            var sProjectId = oBindingContext.getProperty("id");
            var sProjectName = oBindingContext.getProperty("name");
            var oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            MessageBox.confirm(
                oResourceBundle.getText("projectList.deleteConfirm", [sProjectName]),
                {
                    title: oResourceBundle.getText("projectList.deleteTitle"),
                    onClose: function (oAction) {
                        if (oAction === MessageBox.Action.OK) {
                            this._deleteProject(sProjectId, sProjectName);
                        }
                    }.bind(this)
                }
            );
        },

        /**
         * Perform project deletion via OData
         * @param {string} sProjectId - The project ID to delete
         * @param {string} sProjectName - The project name for the message
         */
        _deleteProject: function (sProjectId, sProjectName) {
            var oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            this.getOwnerComponent().deleteProject(sProjectId).then(function () {
                MessageToast.show(oResourceBundle.getText("projectList.deleted", [sProjectName]));
            }).catch(function (oError) {
                MessageBox.error("Error deleting project: " + oError.message);
            });
        }
    });
});
