sap.ui.define([
    "scheduler/controller/BaseController",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast"
], function (BaseController, JSONModel, MessageToast) {
    "use strict";


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
                busy: false,
                ibpTemplateName: "",
                ibpSteps: [],
                ibpLoading: false,
                selectedIbpStepIdx: null,
                selectedIbpStepName: "",
                selectedIbpStepParams: [],
                newIbpParam: _newParam()
            });
            this.getView().setModel(this._editModel, "edit");

            this.getRouter().getRoute("stepParameters")
                .attachPatternMatched(this._onMatched, this);
        },

        _onMatched: function (oEvent) {
            var oArgs = oEvent.getParameter("arguments") || {};
            var oQuery = oArgs["?query"] || {};
            var oComp = this.getOwnerComponent();
            var sTargetType = (oQuery.targetType || "DSP").toUpperCase();
            var sJobTemplate = oQuery.jobTemplate || "";
            var sCacheKey = sTargetType === "IBP" ? ("IBP:" + sJobTemplate) : oQuery.taskchain;
            var oExisting = (oComp._stepParamsState && oComp._stepParamsState.cacheKey === sCacheKey)
                ? oComp._stepParamsState
                : null;

            var bHasCached = !!(oExisting && oExisting.steps && oExisting.steps.length);
            var aSteps = bHasCached ? oExisting.steps : [];

            this._editModel.setData({
                taskchain: oQuery.taskchain || "",
                spaceId: oQuery.spaceId || "",
                targetType: sTargetType,
                jobTemplate: sJobTemplate,
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
                if (sTargetType === "IBP" && sJobTemplate) {
                    this._loadStepsFromIbpTemplate(sJobTemplate);
                } else {
                    this._loadStepsFromDsp(oQuery.spaceId, oQuery.taskchain);
                }
            }
        },

        _loadStepsFromIbpTemplate: function (sTemplateName) {
            var that = this;
            fetch("v1/jobs/ibp/template-steps", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ template_name: sTemplateName })
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    var aSteps = [];
                    if (Array.isArray(data.steps)) {
                        aSteps = data.steps.map(function (s) {
                            return {
                                id: s.id || ("s" + s.order),
                                order: "Step " + s.order,
                                name: s.name || ("Step " + s.order),
                                businessName: s.description || "",
                                objectId: s.name || "",
                                description: s.sequenceNumber ? ("Seq " + s.sequenceNumber) : "",
                                allowParams: true,
                                params: []
                            };
                        });
                    }
                    that._editModel.setProperty("/steps", aSteps);
                })
                .catch(function () {
                    that._editModel.setProperty("/steps", []);
                })
                .then(function () { that._editModel.setProperty("/busy", false); });
        },

        _loadStepsFromDsp: function (sSpaceId, sTaskchain) {
            var that = this;
            if (!sSpaceId || !sTaskchain) {
                this._editModel.setProperty("/steps", []);
                this._editModel.setProperty("/busy", false);
                return;
            }

            function parseJson(txt) {
                try { return txt ? JSON.parse(txt) : {}; } catch (e) { return {}; }
            }

            // 1. Try the DAG endpoint (uses last run's structure + business names).
            var sDagUrl = "v1/dsp/taskchain-dag?spaceId=" + encodeURIComponent(sSpaceId)
                + "&taskchain=" + encodeURIComponent(sTaskchain);

            fetch(sDagUrl, { headers: { "Accept": "application/json" } })
                .then(function (res) {
                    return res.text().then(function (txt) {
                        return { ok: res.ok, data: parseJson(txt) };
                    });
                })
                .then(function (r) {
                    var aSteps = [];
                    if (r.ok && r.data && r.data.success && Array.isArray(r.data.nodes)) {
                        var _structural = ["BEGIN", "START", "END", "SPLIT", "MERGE", "JOIN", "GATEWAY", "FORK", "CONVERGE"];
                        aSteps = r.data.nodes
                            .filter(function (n) {
                                var t = String(n.type || "TASK").toUpperCase();
                                return _structural.indexOf(t) === -1 && !!n.objectId;
                            })
                            .map(function (n, i) {
                                return {
                                    id: n.id || ("s" + (i + 1)),
                                    order: "Step " + (i + 1),
                                    name: n.objectId || n.id || ("Step " + (i + 1)),
                                    businessName: n.businessName || n.label || "",
                                    objectId: n.objectId || "",
                                    description: n.description || "",
                                    applicationId: n.applicationId || "",
                                    ibpTemplateName: n.ibpTemplateName || "",
                                    allowParams: true,
                                    params: []
                                };
                            });
                    }
                    if (aSteps.length) {
                        return aSteps;
                    }
                    // 2. Fallback: query distinct steps from execution logs.
                    var sStepsUrl = "v1/dsp/taskchain-steps?spaceId=" + encodeURIComponent(sSpaceId)
                        + "&taskchain=" + encodeURIComponent(sTaskchain);
                    return fetch(sStepsUrl, { headers: { "Accept": "application/json" } })
                        .then(function (res2) {
                            return res2.text().then(function (txt2) {
                                return { ok: res2.ok, data: parseJson(txt2) };
                            });
                        })
                        .then(function (r2) {
                            if (r2.ok && r2.data && r2.data.success && Array.isArray(r2.data.steps)) {
                                return r2.data.steps.map(function (s) {
                                    return {
                                        id: s.id || s.objectId,
                                        order: "Step " + s.order,
                                        name: s.objectId || s.id,
                                        businessName: s.businessName || "",
                                        objectId: s.objectId || "",
                                        description: "",
                                        applicationId: s.applicationId || "",
                                        ibpTemplateName: s.ibpTemplateName || "",
                                        allowParams: true,
                                        params: []
                                    };
                                });
                            }
                            return [];
                        });
                })
                .then(function (aSteps) {
                    that._editModel.setProperty("/steps", aSteps || []);
                })
                .catch(function () {
                    that._editModel.setProperty("/steps", []);
                })
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
            var sReturnTo = this._editModel.getProperty("/returnTo") || "scheduleList";
            var oReturnQuery = this._editModel.getProperty("/returnQuery") || {};
            this.getRouter().navTo(sReturnTo, { "?query": oReturnQuery }, true);
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
            var sDisplayName = oStep.businessName
                ? oStep.name + " — " + oStep.businessName
                : oStep.name;
            var aCachedIbpSteps = oStep.ibpSteps || [];
            this._editModel.setProperty("/selectedStepId", oStep.id);
            this._editModel.setProperty("/selectedStepName", oStep.order + ": " + sDisplayName);
            this._editModel.setProperty("/selectedStepParams", oStep.params || []);
            this._editModel.setProperty("/newParam", _newParam());
            this._editModel.setProperty("/ibpTemplateName", oStep.ibpTemplateName || "");
            this._editModel.setProperty("/ibpSteps", aCachedIbpSteps);
            this._editModel.setProperty("/ibpLoading", false);
            this._editModel.setProperty("/selectedIbpStepIdx", null);
            this._editModel.setProperty("/selectedIbpStepName", "");
            this._editModel.setProperty("/selectedIbpStepParams", []);
            this._editModel.setProperty("/newIbpParam", _newParam());

            if (oStep.ibpTemplateName && !aCachedIbpSteps.length) {
                this._doLoadIbpSteps(oStep.ibpTemplateName);
            }
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

        onLoadIbpSteps: function () {
            var sTemplate = (this._editModel.getProperty("/ibpTemplateName") || "").trim();
            if (!sTemplate) return;
            this._doLoadIbpSteps(sTemplate);
        },

        _doLoadIbpSteps: function (sTemplate) {
            var that = this;
            this._editModel.setProperty("/ibpLoading", true);
            this._editModel.setProperty("/ibpSteps", []);
            fetch("v1/jobs/ibp/template-steps", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ template_name: sTemplate })
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (data.error) {
                        MessageToast.show("IBP error: " + data.error);
                        return;
                    }
                    // Preserve existing params for steps that were already configured
                    var aExisting = that._editModel.getProperty("/ibpSteps") || [];
                    var oExistingByName = {};
                    aExisting.forEach(function(s) { oExistingByName[s.name] = s.params || []; });

                    var aSteps = (Array.isArray(data.steps) ? data.steps : []).map(function(s) {
                        return Object.assign({}, s, { params: oExistingByName[s.name] || [] });
                    });
                    that._editModel.setProperty("/ibpSteps", aSteps);
                    // Persist in the current DSP step so switching steps doesn't lose params
                    var oCur = that._currentStep();
                    if (oCur) {
                        that._editModel.setProperty("/steps/" + oCur.idx + "/ibpSteps", aSteps);
                    }
                })
                .catch(function (e) {
                    MessageToast.show("Failed to load IBP template: " + e.message);
                })
                .finally(function () {
                    that._editModel.setProperty("/ibpLoading", false);
                });
        },

        onIbpStepSelect: function (oEvt) {
            this._selectIbpStepByListItem(oEvt.getParameter("listItem"));
        },

        onIbpStepPress: function (oEvt) {
            this._selectIbpStepByListItem(oEvt.getSource());
        },

        _selectIbpStepByListItem: function (oItem) {
            if (!oItem) return;
            var oCtx = oItem.getBindingContext("edit");
            if (!oCtx) return;
            var sPath = oCtx.getPath(); // /ibpSteps/<i>
            var iIdx = parseInt(sPath.split("/").pop(), 10);
            var oStep = oCtx.getObject();
            this._editModel.setProperty("/selectedIbpStepIdx", iIdx);
            this._editModel.setProperty("/selectedIbpStepName", oStep.name || "");
            this._editModel.setProperty("/selectedIbpStepParams", oStep.params || []);
            this._editModel.setProperty("/newIbpParam", _newParam());
        },

        _currentIbpStep: function () {
            var iIdx = this._editModel.getProperty("/selectedIbpStepIdx");
            if (iIdx === null || iIdx === undefined) return null;
            var aSteps = this._editModel.getProperty("/ibpSteps") || [];
            if (iIdx >= 0 && iIdx < aSteps.length) {
                return { idx: iIdx, step: aSteps[iIdx] };
            }
            return null;
        },

        onAddIbpStepParam: function () {
            var oNew = this._editModel.getProperty("/newIbpParam") || {};
            if (!oNew.key || !String(oNew.key).trim()) {
                MessageToast.show("Param Key is required");
                return;
            }
            var oCurIbp = this._currentIbpStep();
            if (!oCurIbp) { MessageToast.show("Select an IBP step first"); return; }
            var aParams = (oCurIbp.step.params || []).slice();
            aParams.push({ key: String(oNew.key).trim(), value: oNew.value == null ? "" : String(oNew.value), active: !!oNew.active });
            this._editModel.setProperty("/ibpSteps/" + oCurIbp.idx + "/params", aParams);
            var oCurDsp = this._currentStep();
            if (oCurDsp) { this._editModel.setProperty("/steps/" + oCurDsp.idx + "/ibpSteps/" + oCurIbp.idx + "/params", aParams); }
            this._editModel.setProperty("/selectedIbpStepParams", aParams);
            this._editModel.setProperty("/newIbpParam", _newParam());
        },

        onEditIbpStepParam: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            var oRow = oCtx.getObject();
            this._editModel.setProperty("/newIbpParam", { key: oRow.key, value: oRow.value, active: !!oRow.active });
            this.onDeleteIbpStepParam(oEvt);
        },

        onDeleteIbpStepParam: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            var iIdx = parseInt(oCtx.getPath().split("/").pop(), 10);
            var oCurIbp = this._currentIbpStep();
            if (!oCurIbp || isNaN(iIdx)) return;
            var aParams = (oCurIbp.step.params || []).slice();
            aParams.splice(iIdx, 1);
            this._editModel.setProperty("/ibpSteps/" + oCurIbp.idx + "/params", aParams);
            var oCurDsp = this._currentStep();
            if (oCurDsp) { this._editModel.setProperty("/steps/" + oCurDsp.idx + "/ibpSteps/" + oCurIbp.idx + "/params", aParams); }
            this._editModel.setProperty("/selectedIbpStepParams", aParams);
        },

        onResetIbpNewParam: function () {
            this._editModel.setProperty("/newIbpParam", _newParam());
        },

        onSave: function () {
            var oComp = this.getOwnerComponent();
            var aSteps = this._editModel.getProperty("/steps") || [];
            var sTc = this._editModel.getProperty("/taskchain");
            var sTargetType = this._editModel.getProperty("/targetType") || "DSP";
            var sJobTemplate = this._editModel.getProperty("/jobTemplate") || "";
            var sCacheKey = sTargetType === "IBP" ? ("IBP:" + sJobTemplate) : sTc;

            // Build flat parameters JSON: { stepName: [{key,value,active}], "apiStep::ibpStep": [...] }
            var oOut = {};
            aSteps.forEach(function (s) {
                if (s.params && s.params.length) {
                    oOut[s.name] = s.params;
                }
                (s.ibpSteps || []).forEach(function (is) {
                    if (is.params && is.params.length) {
                        oOut[s.name + "::" + is.name] = is.params;
                    }
                });
            });

            oComp._stepParamsState = {
                cacheKey: sCacheKey,
                taskchain: sTc,
                steps: aSteps,
                parametersJson: JSON.stringify(oOut)
            };

            MessageToast.show("Step parameters saved");
            var sReturnTo = this._editModel.getProperty("/returnTo") || "scheduleList";
            var oReturnQuery = this._editModel.getProperty("/returnQuery") || {};
            this.getRouter().navTo(sReturnTo, { "?query": oReturnQuery }, true);
        }
    });
});
