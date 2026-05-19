sap.ui.define([
    "scheduler/controller/BaseController",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/routing/History"
], function (BaseController, JSONModel, MessageToast, MessageBox, History) {
    "use strict";

    var DEFAULT_STEPS = [
        { id: "s1", order: "Step 1", name: "Extract Data",   allowParams: true,  params: [] },
        { id: "s2", order: "Step 2", name: "Transform Data", allowParams: false, params: [] },
        { id: "s3", order: "Step 3", name: "Load Data",      allowParams: true,  params: [] },
        { id: "s4", order: "Step 4", name: "Notify",         allowParams: false, params: [] }
    ];

    function _newParam() {
        return { key: "", value: "", active: true };
    }

    return BaseController.extend("scheduler.controller.StepParametersPage", {

        onInit: function () {
            this._editModel = new JSONModel({
                taskchain: "",
                spaceId: "",
                returnTo: "scheduleList",
                returnQuery: {},
                steps: [],
                selectedStepId: null,
                selectedStepName: "",
                selectedStepParams: [],
                newParam: _newParam(),
                busy: false
            });
            this.getView().setModel(this._editModel, "edit");

            this.getRouter().getRoute("stepParameters")
                .attachPatternMatched(this._onMatched, this);
        },

        _onMatched: function (oEvent) {
            var oArgs = oEvent.getParameter("arguments") || {};
            var oQuery = oArgs["?query"] || {};
            var oComp = this.getOwnerComponent();
            var oExisting = (oComp._stepParamsState && oComp._stepParamsState.taskchain === oQuery.taskchain)
                ? oComp._stepParamsState
                : null;

            var bHasCached = !!(oExisting && oExisting.steps && oExisting.steps.length);
            var aSteps = bHasCached ? oExisting.steps : [];

            this._editModel.setData({
                taskchain: oQuery.taskchain || "",
                spaceId: oQuery.spaceId || "",
                returnTo: oQuery.returnTo || "scheduleList",
                returnQuery: this._parseReturnQuery(oQuery),
                steps: aSteps,
                selectedStepId: null,
                selectedStepName: "",
                selectedStepParams: [],
                newParam: _newParam(),
                busy: !bHasCached
            });

            if (!bHasCached) {
                this._loadStepsFromDsp(oQuery.spaceId, oQuery.taskchain);
            }
        },

        _loadStepsFromDsp: function (sSpaceId, sTaskchain) {
            var that = this;
            var fallback = function () {
                that._editModel.setProperty("/steps",
                    DEFAULT_STEPS.map(function (s) { return Object.assign({}, s, { params: s.params.slice() }); })
                );
            };
            if (!sSpaceId || !sTaskchain) {
                fallback();
                this._editModel.setProperty("/busy", false);
                return;
            }
            var sUrl = "v1/dsp/taskchain-dag?spaceId=" + encodeURIComponent(sSpaceId)
                + "&taskchain=" + encodeURIComponent(sTaskchain);
            fetch(sUrl, { headers: { "Content-Type": "application/json" } })
                .then(function (res) {
                    return res.text().then(function (txt) {
                        var data;
                        try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = {}; }
                        return { ok: res.ok, data: data };
                    });
                })
                .then(function (r) {
                    var aSteps = [];
                    if (r.ok && r.data && r.data.success && Array.isArray(r.data.nodes)) {
                        aSteps = r.data.nodes
                            .filter(function (n) {
                                var t = String(n.type || "TASK").toUpperCase();
                                return t === "TASK" || t === "REPLICATION_FLOW" || t === "DATA_FLOW" || t === "VIEW_PERSISTENCE";
                            })
                            .map(function (n, i) {
                                var sName = n.label || n.objectId || n.id || ("Step " + (i + 1));
                                return {
                                    id: n.id || ("s" + (i + 1)),
                                    order: "Step " + (i + 1),
                                    name: sName,
                                    objectId: n.objectId || "",
                                    description: n.description || "",
                                    allowParams: true,
                                    params: []
                                };
                            });
                    }
                    if (!aSteps.length) {
                        fallback();
                    } else {
                        that._editModel.setProperty("/steps", aSteps);
                    }
                })
                .catch(function () { fallback(); })
                .then(function () { that._editModel.setProperty("/busy", false); });
        },

        _parseReturnQuery: function (oQuery) {
            // Re-build query string for the calling page from what we received
            var out = {};
            if (oQuery.spaceId)   out.spaceId   = oQuery.spaceId;
            if (oQuery.taskchain) out.taskchain = oQuery.taskchain;
            if (oQuery.name)      out.name      = oQuery.name;
            return out;
        },

        onNavBack: function () {
            var oHistory = History.getInstance();
            var sPrev = oHistory.getPreviousHash();
            if (sPrev !== undefined) {
                window.history.go(-1);
            } else {
                this.getRouter().navTo("scheduleList", {}, true);
            }
        },

        onStepSelect: function (oEvt) {
            var oItem = oEvt.getParameter("listItem");
            this._selectStepByListItem(oItem);
        },

        onStepPress: function (oEvt) {
            this._selectStepByListItem(oEvt.getSource());
        },

        _selectStepByListItem: function (oItem) {
            if (!oItem) return;
            var oCtx = oItem.getBindingContext("edit");
            if (!oCtx) return;
            var oStep = oCtx.getObject();
            this._editModel.setProperty("/selectedStepId", oStep.id);
            this._editModel.setProperty("/selectedStepName", oStep.order + ": " + oStep.name);
            this._editModel.setProperty("/selectedStepParams", oStep.params || []);
            this._editModel.setProperty("/newParam", _newParam());
        },

        _currentStep: function () {
            var sId = this._editModel.getProperty("/selectedStepId");
            if (!sId) return null;
            var aSteps = this._editModel.getProperty("/steps") || [];
            for (var i = 0; i < aSteps.length; i++) {
                if (aSteps[i].id === sId) return { idx: i, step: aSteps[i] };
            }
            return null;
        },

        onAddParam: function () {
            var oNew = this._editModel.getProperty("/newParam") || {};
            if (!oNew.key || !String(oNew.key).trim()) {
                MessageToast.show("Param Key is required");
                return;
            }
            var oCur = this._currentStep();
            if (!oCur) {
                MessageToast.show("Select a step first");
                return;
            }
            var aParams = (oCur.step.params || []).slice();
            aParams.push({
                key: String(oNew.key).trim(),
                value: oNew.value == null ? "" : String(oNew.value),
                active: !!oNew.active
            });
            this._editModel.setProperty("/steps/" + oCur.idx + "/params", aParams);
            this._editModel.setProperty("/selectedStepParams", aParams);
            this._editModel.setProperty("/newParam", _newParam());
        },

        onResetNewParam: function () {
            this._editModel.setProperty("/newParam", _newParam());
        },

        onEditParam: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            var oRow = oCtx.getObject();
            this._editModel.setProperty("/newParam", {
                key: oRow.key, value: oRow.value, active: !!oRow.active
            });
            this.onDeleteParam(oEvt);
        },

        onDeleteParam: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            var sPath = oCtx.getPath(); // /selectedStepParams/<i>
            var iIdx = parseInt(sPath.split("/").pop(), 10);
            var oCur = this._currentStep();
            if (!oCur || isNaN(iIdx)) return;
            var aParams = (oCur.step.params || []).slice();
            aParams.splice(iIdx, 1);
            this._editModel.setProperty("/steps/" + oCur.idx + "/params", aParams);
            this._editModel.setProperty("/selectedStepParams", aParams);
        },

        onSave: function () {
            var oComp = this.getOwnerComponent();
            var aSteps = this._editModel.getProperty("/steps") || [];
            var sTc = this._editModel.getProperty("/taskchain");

            // Build flat parameters JSON: { stepName: [ {key,value,active}, ... ] }
            var oOut = {};
            aSteps.forEach(function (s) {
                if (s.params && s.params.length) {
                    oOut[s.name] = s.params;
                }
            });

            oComp._stepParamsState = {
                taskchain: sTc,
                steps: aSteps,
                parametersJson: JSON.stringify(oOut)
            };

            MessageToast.show("Step parameters saved");
            this.onNavBack();
        }
    });
});
