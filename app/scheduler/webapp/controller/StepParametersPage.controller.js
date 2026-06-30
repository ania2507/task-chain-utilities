sap.ui.define([
    "scheduler/controller/BaseController",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox"
], function (BaseController, JSONModel, MessageToast, MessageBox) {
    "use strict";


    // Expand YYYYMM → SAC time-hierarchy nested path.
    // "202502" → ["(all)", "2025", "20251", "202502"]  (quarter = ceil(month/3))
    function _expandDateYYYYMM(sVal) {
        var m = /^(20\d\d)(0[1-9]|1[0-2])$/.exec((sVal || "").trim());
        if (!m) { return null; }
        var sYear = m[1], nQuarter = Math.ceil(parseInt(m[2], 10) / 3);
        return ["(all)", sYear, sYear + nQuarter, sVal.trim()];
    }

    function _newParam() {
        return { key: "", value: "", active: true, description: "", hierarchyId: "", needsHierarchyId: false };
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
                selectedStepIsBlocked: false,
                selectedStepParams: [],
                newParam: _newParam(),
                busy: false,
                ibpTemplateName: "",
                ibpSteps: [],
                ibpLoading: false,
                ibpGlobalVars: [],
                selectedIbpStepIdx: null,
                selectedIbpStepName: "",
                selectedIbpStepParams: [],
                newIbpParam: _newParam(),
                sacMultiActionId: "",
                sacMultiActionName: "",
                sacLoading: false,
                sacLoadingText: "",
                sacParamSchema: [],
                sacParamSchemaUnavailable: false,
                sacNoParameters: false,
                hasSacSteps: false
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

            // Always fetch steps fresh from DSP/IBP so external changes are reflected.
            // Parameter values are loaded from the OData model by _applyParamsJsonToSteps().

            this._editModel.setData({
                taskchain: oQuery.taskchain || "",
                spaceId: oQuery.spaceId || "",
                targetType: sTargetType,
                jobTemplate: sJobTemplate,
                returnTo: oQuery.returnTo || "scheduleList",
                returnQuery: this._parseReturnQuery(oQuery),
                viewOnly: oQuery.viewOnly === "1",
                steps: [],
                selectedStepId: null,
                selectedStepName: "",
                selectedStepIsBlocked: false,
                selectedStepParams: [],
                newParam: _newParam(),
                busy: true,
                ibpTemplateName: "",
                ibpSteps: [],
                ibpLoading: false,
                ibpGlobalVars: [],
                selectedIbpStepIdx: null,
                selectedIbpStepName: "",
                selectedIbpStepParams: [],
                newIbpParam: _newParam(),
                sacMultiActionId: "",
                sacMultiActionName: "",
                sacLoading: false,
                sacLoadingText: "",
                sacParamSchema: [],
                sacParamSchemaUnavailable: false,
                sacNoParameters: false,
                hasSacSteps: false
            });

            if (sTargetType === "IBP" && sJobTemplate) {
                this._loadStepsFromIbpTemplate(sJobTemplate);
            } else {
                this._loadStepsFromDsp(oQuery.spaceId, oQuery.taskchain);
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

            fetch(sDagUrl, { headers: { "Accept": "application/json", "Cache-Control": "no-cache" } })
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
                                    sacMultiActionId: n.sacMultiActionId || "",
                                    objectType: n.objectType || "",
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
                    return fetch(sStepsUrl, { headers: { "Accept": "application/json", "Cache-Control": "no-cache" } })
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
                                        sacMultiActionId: s.sacMultiActionId || "",
                                        objectType: s.objectType || "",
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
                    that._applyParamsJsonToSteps();
                    var bHasSac = (aSteps || []).some(function (s) { return !!s.sacMultiActionId; });
                    that._editModel.setProperty("/hasSacSteps", bHasSac);
                    // Pre-load IBP sub-steps in background so param count is visible immediately
                    (aSteps || []).forEach(function (step, idx) {
                        if (step.ibpTemplateName) {
                            that._preloadIbpStepsForDspStep(idx, step.ibpTemplateName, step.name);
                        }
                    });
                })
                .catch(function () {
                    that._editModel.setProperty("/steps", []);
                })
                .then(function () { that._editModel.setProperty("/busy", false); });
        },

        _preloadIbpStepsForDspStep: function (iDspIdx, sTemplate, sStepName) {
            var that = this;
            fetch("v1/jobs/ibp/template-steps", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ template_name: sTemplate })
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (data.error) return;
                    // Consume _restoredIbpParams here (inside the .then) so that
                    // _doLoadIbpSteps triggered by the user clicking a step before
                    // this response arrives can still read and consume it first.
                    var oExistingByName = {};
                    var oRestored = that._restoredIbpParams && that._restoredIbpParams[sStepName];
                    if (oRestored) {
                        Object.keys(oRestored).forEach(function (n) { oExistingByName[n] = oRestored[n]; });
                        delete that._restoredIbpParams[sStepName];
                    }
                    var aIbpSteps = (Array.isArray(data.steps) ? data.steps : []).map(function (s) {
                        var aExisting = oExistingByName[s.name] || [];
                        var aParams = aExisting;
                        if (!aParams.length && Array.isArray(s.globalVars) && s.globalVars.length) {
                            aParams = s.globalVars
                                .filter(function (g) { return g.name; })
                                .map(function (g) {
                                    return {
                                        key: g.name,
                                        value: g.currentValue || "",
                                        active: true,
                                        description: g.label || "",
                                        ibpParamName: g.ibpParamName || "",
                                        ibpVarNameParam: g.ibpVarNameParam || "",
                                        mandatory: !!g.mandatory
                                    };
                                });
                        }
                        return Object.assign({}, s, { params: aParams });
                    });
                    // Update the DSP step's ibpSteps only if not already loaded by user interaction
                    var aAllSteps = that._editModel.getProperty("/steps") || [];
                    if (iDspIdx < aAllSteps.length && !(aAllSteps[iDspIdx].ibpSteps || []).length) {
                        var aUpdated = aAllSteps.map(function (s, i) {
                            return i === iDspIdx ? Object.assign({}, s, { ibpSteps: aIbpSteps }) : s;
                        });
                        that._editModel.setProperty("/steps", aUpdated);
                    }
                })
                .catch(function () {});
        },

        _loadSacParameters: function (sSacId, iRetry) {
            var that = this;
            var nRetry = iRetry || 0;
            if (!nRetry) {
                this._editModel.setProperty("/sacLoading", true);
            }
            fetch("v1/jobs/sac/multiaction-parameters/" + encodeURIComponent(sSacId), {
                headers: { "Accept": "application/json" }
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (data.error) {
                        that._editModel.setProperty("/sacLoading", false);
                        return;
                    }
                    if (data.name) {
                        that._editModel.setProperty("/sacMultiActionName", data.name);
                    }

                    // Backend probe runs in a background thread — keep loading indicator
                    // active and retry every 8s while the probe is still running (up to 10x)
                    if (data.probing && nRetry < 10) {
                        setTimeout(function () {
                            if (that._editModel.getProperty("/sacMultiActionId") === sSacId) {
                                that._loadSacParameters(sSacId, nRetry + 1);
                            } else {
                                that._editModel.setProperty("/sacLoading", false);
                            }
                        }, 8000);
                        return;
                    }

                    var aSchema = data.parameters || [];
                    that._editModel.setProperty("/sacParamSchema", aSchema);
                    that._editModel.setProperty("/sacNoParameters", !!data.noParameters);
                    that._editModel.setProperty("/sacParamSchemaUnavailable", !aSchema.length && !data.noParameters);
                    var aParams = aSchema.map(function (p) {
                        var sVal = p.currentValue || "";
                        var sHId = "";
                        // For hierarchyId params, split the JSON template into separate fields
                        if (sVal.indexOf("{") === 0) {
                            try {
                                var oParsed = JSON.parse(sVal);
                                var aMembers = oParsed.memberIds || [];
                                var firstMember = aMembers[0];
                                if (Array.isArray(firstMember)) {
                                    // Time hierarchy nested path → show only the leaf (e.g. "202502")
                                    sVal = firstMember.length ? firstMember[firstMember.length - 1] : "";
                                } else {
                                    sVal = firstMember || "";
                                }
                                sHId = oParsed.hierarchyId || "";
                            } catch (e) { /* leave sVal as-is */ }
                        }
                        return {
                            key: p.id,
                            value: sVal,
                            active: true,
                            description: p.label || "",
                            mandatory: !!p.mandatory,
                            needsHierarchyId: !!p.needsHierarchyId,
                            hierarchyId: sHId
                        };
                    });
                    var oCur = that._currentStep();
                    var aExisting = oCur ? (oCur.step.params || []) : [];
                    if (!aExisting.length && aParams.length) {
                        that._editModel.setProperty("/selectedStepParams", aParams);
                        if (oCur) {
                            that._editModel.setProperty("/steps/" + oCur.idx + "/params", aParams);
                        }
                    }
                    that._editModel.setProperty("/sacLoading", false);
                })
                .catch(function () {
                    that._editModel.setProperty("/sacLoading", false);
                });
        },

        onSacKeyValueHelp: function () {
            var aSchema = this._editModel.getProperty("/sacParamSchema") || [];
            if (!aSchema.length) {
                var sSacId = this._editModel.getProperty("/sacMultiActionId");
                if (!sSacId) {
                    sap.m.MessageToast.show("Select a SAC step first");
                } else {
                    sap.m.MessageToast.show("SAC does not expose parameter definitions for this multi action — add parameters manually using the form below");
                }
                return;
            }

            var that = this;
            var oVhModel = new sap.ui.model.json.JSONModel({ params: aSchema });

            if (this._oSacKeyVHD) {
                this._oSacKeyVHD.setModel(oVhModel, "vh");
                this._oSacKeyVHD.open();
                return;
            }

            sap.ui.require([
                "sap/m/SelectDialog",
                "sap/m/StandardListItem",
                "sap/ui/model/Filter",
                "sap/ui/model/FilterOperator"
            ], function (SelectDialog, StandardListItem, Filter, FilterOperator) {
                that._oSacKeyVHD = new SelectDialog({
                    title: "SAC Multi Action — Parameters",
                    rememberSelections: false,
                    confirm: function (oEvt) {
                        var oItem = oEvt.getParameter("selectedItem");
                        if (!oItem) return;
                        var oCtx = oItem.getBindingContext("vh");
                        if (!oCtx) return;
                        that._editModel.setProperty("/newParam/key", oCtx.getProperty("id"));
                        that._editModel.setProperty("/newParam/description", oCtx.getProperty("label") || "");
                        var sVal = oCtx.getProperty("currentValue");
                        if (sVal) {
                            that._editModel.setProperty("/newParam/value", sVal);
                        }
                    },
                    liveChange: function (oEvt) {
                        var sVal = oEvt.getParameter("value");
                        var oBinding = that._oSacKeyVHD.getBinding("items");
                        if (oBinding) {
                            oBinding.filter(sVal ? [new Filter({
                                filters: [
                                    new Filter("id", FilterOperator.Contains, sVal),
                                    new Filter("label", FilterOperator.Contains, sVal)
                                ],
                                and: false
                            })] : []);
                        }
                    }
                });
                that.getView().addDependent(that._oSacKeyVHD);
                that._oSacKeyVHD.setModel(oVhModel, "vh");
                that._oSacKeyVHD.bindAggregation("items", {
                    path: "vh>/params",
                    template: new StandardListItem({
                        title: "{vh>id}",
                        description: "{vh>label}",
                        info: "{= ${vh>mandatory} ? 'Mandatory' : 'Optional' }",
                        infoState: "{= ${vh>mandatory} ? 'Error' : 'None' }"
                    })
                });
                that._oSacKeyVHD.open();
            });
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

        // Apply parametersJson from _stepParamsState (loaded from OData) onto freshly
        // loaded DSP steps.  IBP sub-step params are NOT injected into ibpSteps here
        // (that would hide the other IBP steps that had no params).  Instead they are
        // stored in _restoredIbpParams so _doLoadIbpSteps can merge them when the
        // full IBP template step list is fetched.
        _applyParamsJsonToSteps: function () {
            var oComp = this.getOwnerComponent();
            var s = oComp && oComp._stepParamsState;
            if (!s || !s.parametersJson) return;
            try {
                var oParams = JSON.parse(s.parametersJson);
                var aSteps = (this._editModel.getProperty("/steps") || []).slice();
                var bChanged = false;
                this._restoredIbpParams = {};
                var that = this;

                aSteps.forEach(function (step, idx) {
                    // Current format: { "DSPStep": [{key,value,active,step?}] }
                    var allParams = oParams[step.name];

                    // Legacy format: { "DSPStep::IBPStep": [{key,value,active}] }
                    if (!allParams) {
                        allParams = [];
                        Object.keys(oParams).forEach(function (k) {
                            var prefix = step.name + "::";
                            if (k.indexOf(prefix) === 0) {
                                var ibpStepName = k.substring(prefix.length);
                                (oParams[k] || []).forEach(function (p) {
                                    allParams.push(Object.assign({}, p, { step: ibpStepName }));
                                });
                            }
                        });
                    }

                    if (!allParams || !allParams.length) return;
                    bChanged = true;

                    var dspParams = allParams.filter(function (p) { return !p.step; });
                    // IBP sub-step params → stored in _restoredIbpParams, not in ibpSteps,
                    // so _doLoadIbpSteps still fetches all template steps from IBP.
                    allParams.filter(function (p) { return p.step; }).forEach(function (p) {
                        if (!that._restoredIbpParams[step.name]) that._restoredIbpParams[step.name] = {};
                        var map = that._restoredIbpParams[step.name];
                        if (!map[p.step]) map[p.step] = [];
                        map[p.step].push({ key: p.key, value: p.value, active: p.active !== false, description: p.description || "", ibpParamName: p.ibpParamName || "", ibpVarNameParam: p.ibpVarNameParam || "", mandatory: !!p.mandatory });
                    });
                    aSteps[idx] = Object.assign({}, step, { params: dspParams });
                });
                if (bChanged) {
                    this._editModel.setProperty("/steps", aSteps);
                }
            } catch (_) {}
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

            var sTargetType = this._editModel.getProperty("/targetType") || "DSP";
            var sDisplayName = oStep.businessName
                ? oStep.name + " — " + oStep.businessName
                : oStep.name;

            if (sTargetType === "DSP" && !this._isApiStep(oStep)) {
                this._editModel.setProperty("/selectedStepId", oStep.id);
                this._editModel.setProperty("/selectedStepName", oStep.order + ": " + sDisplayName);
                this._editModel.setProperty("/selectedStepIsBlocked", true);
                this._editModel.setProperty("/selectedStepParams", []);
                this._editModel.setProperty("/ibpTemplateName", "");
                this._editModel.setProperty("/ibpSteps", []);
                this._editModel.setProperty("/ibpLoading", false);
                this._editModel.setProperty("/selectedIbpStepIdx", null);
                this._editModel.setProperty("/selectedIbpStepName", "");
                this._editModel.setProperty("/selectedIbpStepParams", []);
                this._editModel.setProperty("/sacMultiActionId", "");
                this._editModel.setProperty("/sacMultiActionName", "");
                return;
            }

            var aCachedIbpSteps = oStep.ibpSteps || [];
            this._editModel.setProperty("/selectedStepId", oStep.id);
            this._editModel.setProperty("/selectedStepName", oStep.order + ": " + sDisplayName);
            this._editModel.setProperty("/selectedStepIsBlocked", false);
            this._editModel.setProperty("/selectedStepParams", (oStep.params || []).filter(function (p) {
                return !String(p.key || "").startsWith("__");
            }));
            this._editModel.setProperty("/newParam", _newParam());
            this._editModel.setProperty("/ibpTemplateName", oStep.ibpTemplateName || "");
            this._editModel.setProperty("/ibpSteps", aCachedIbpSteps);
            this._editModel.setProperty("/ibpLoading", false);
            this._editModel.setProperty("/selectedIbpStepIdx", null);
            this._editModel.setProperty("/selectedIbpStepName", "");
            this._editModel.setProperty("/selectedIbpStepParams", []);
            this._editModel.setProperty("/newIbpParam", _newParam());
            this._editModel.setProperty("/sacMultiActionId", oStep.sacMultiActionId || "");
            this._editModel.setProperty("/sacMultiActionName", oStep.sacMultiActionName || "");

            if (oStep.ibpTemplateName && !aCachedIbpSteps.length) {
                this._doLoadIbpSteps(oStep.ibpTemplateName);
            }
            if (oStep.sacMultiActionId && !(oStep.params || []).length) {
                this._loadSacParameters(oStep.sacMultiActionId);
            }
        },

        // A DSP step accepts parameters only if it's an API-trigger task (DSP names
        // these objects "APITask_..."), or its repository object type is "API",
        // or it already has an IBP/SAC job template resolved.
        _isApiStep: function (oStep) {
            if (!oStep) return false;
            if (oStep.ibpTemplateName) return true;
            if (oStep.sacMultiActionId) return true;
            if ((oStep.objectType || "").toUpperCase().indexOf("API") !== -1) return true;
            return (oStep.objectId || "").toUpperCase().indexOf("APITASK") === 0;
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
            // Capture existing params BEFORE clearing /ibpSteps.
            // Priority: cached ibpSteps on the current DSP step (survive step-switching),
            // falling back to the current /ibpSteps working list.
            var oCurPre = this._currentStep();
            var aPre = (oCurPre && this._editModel.getProperty("/steps/" + oCurPre.idx + "/ibpSteps"))
                || this._editModel.getProperty("/ibpSteps") || [];
            var oExistingByName = {};
            aPre.forEach(function (s) { oExistingByName[s.name] = s.params || []; });

            this._editModel.setProperty("/ibpLoading", true);
            this._editModel.setProperty("/ibpSteps", []);
            var oCurForRestore = this._currentStep();
            var oRestoredForStep = oCurForRestore && this._restoredIbpParams
                && this._restoredIbpParams[oCurForRestore.step.name];
            if (oRestoredForStep) {
                // Merge restored params into oExistingByName and consume the entry
                Object.keys(oRestoredForStep).forEach(function (n) {
                    if (!oExistingByName[n] || !oExistingByName[n].length) {
                        oExistingByName[n] = oRestoredForStep[n];
                    }
                });
                delete this._restoredIbpParams[oCurForRestore.step.name];
            }
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
                    // Store global vars ($G_*) at template level for the match code
                    var aTemplateGlobalVars = data.globalVars || [];
                    that._editModel.setProperty("/ibpGlobalVars", aTemplateGlobalVars);
                    var aSteps = (Array.isArray(data.steps) ? data.steps : []).map(function (s) {
                        var aExisting = oExistingByName[s.name] || [];
                        var aParams = aExisting;
                        // Pre-populate only from step-level globalVars (extracted per-step
                        // from IBP seq_param_val) — NOT from template-level to avoid adding
                        // vars to steps that don't define them (e.g. Snapshot Operator).
                        if (!aParams.length && Array.isArray(s.globalVars) && s.globalVars.length) {
                            aParams = s.globalVars
                                .filter(function (g) { return g.name; })
                                .map(function (g) {
                                    return {
                                        key: g.name,
                                        value: g.currentValue || "",
                                        active: true,
                                        description: g.label || "",
                                        ibpParamName: g.ibpParamName || "",
                                        ibpVarNameParam: g.ibpVarNameParam || "",
                                        mandatory: !!g.mandatory
                                    };
                                });
                        }
                        return Object.assign({}, s, { params: aParams });
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

            // Always fetch DSP descriptions — they're more accurate than IBP's
            // generic labels ("Variable Name 1" → "All Sales Organizations")
            this._loadDspGlobalVars(iIdx, oStep.name);
        },

        _loadDspGlobalVars: function (iIbpIdx, sTaskName) {
            if (!sTaskName) return;
            var that = this;
            fetch("v1/dsp/task-global-vars?taskName=" + encodeURIComponent(sTaskName), {
                headers: { "Accept": "application/json" }
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    var aVars = data.globalVars || [];
                    // Build name→description map from DSP metadata (better descriptions than IBP labels)
                    var oDescMap = {};
                    aVars.forEach(function (v) { if (v.name && v.label) oDescMap[v.name] = v.label; });

                    function _patchDesc(aParams) {
                        return aParams.map(function (p) {
                            var sDesc = oDescMap[p.key];
                            return sDesc ? Object.assign({}, p, { description: sDesc }) : p;
                        });
                    }

                    // Cache on the ibpStep object.
                    // If DSP returned no data, keep the existing globalVars from the IBP template
                    // (overwriting with empty would break the match code).
                    var aIbp = (that._editModel.getProperty("/ibpSteps") || []).map(function (s, i) {
                        if (i !== iIbpIdx) return s;
                        var aEffectiveVars = aVars.length ? aVars : (s.globalVars || []);
                        return Object.assign({}, s, { globalVars: aEffectiveVars, params: _patchDesc(s.params || []) });
                    });
                    that._editModel.setProperty("/ibpSteps", aIbp);

                    var oCur = that._currentStep();
                    if (oCur) {
                        var aDsp = (that._editModel.getProperty("/steps/" + oCur.idx + "/ibpSteps") || []).map(function (s, i) {
                            if (i !== iIbpIdx) return s;
                            var aEffVars2 = aVars.length ? aVars : (s.globalVars || []);
                            return Object.assign({}, s, { globalVars: aEffVars2, params: _patchDesc(s.params || []) });
                        });
                        that._editModel.setProperty("/steps/" + oCur.idx + "/ibpSteps", aDsp);
                    }

                    // Also patch selectedIbpStepParams if this step is currently selected
                    if (that._editModel.getProperty("/selectedIbpStepIdx") === iIbpIdx) {
                        var aPatched = _patchDesc(that._editModel.getProperty("/selectedIbpStepParams") || []);
                        that._editModel.setProperty("/selectedIbpStepParams", aPatched);
                    }
                })
                .catch(function () {});
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
            aParams.push({ key: String(oNew.key).trim(), value: oNew.value == null ? "" : String(oNew.value), active: !!oNew.active, description: oNew.description || "", ibpParamName: oNew.ibpParamName || "", ibpVarNameParam: oNew.ibpVarNameParam || "" });
            this._replaceIbpStepParams(oCurIbp.idx, aParams);
            this._editModel.setProperty("/selectedIbpStepParams", aParams);
            this._editModel.setProperty("/newIbpParam", _newParam());
        },

        onEditIbpStepParam: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            var oRow = oCtx.getObject();
            var iIdx = parseInt(oCtx.getPath().split("/").pop(), 10);
            var oCurIbp = this._currentIbpStep();
            if (!oCurIbp || isNaN(iIdx)) return;

            this._editModel.setProperty("/newIbpParam", {
                key: oRow.key, value: oRow.value, active: !!oRow.active, description: oRow.description || "", ibpParamName: oRow.ibpParamName || "", ibpVarNameParam: oRow.ibpVarNameParam || ""
            });

            // Move the row into the "new param" fields for editing, without the
            // delete-confirmation popup (that's only for the standalone Delete
            // action on global-variable params).
            var aParams = (this._editModel.getProperty("/selectedIbpStepParams") || []).slice();
            aParams.splice(iIdx, 1);
            this._replaceIbpStepParams(oCurIbp.idx, aParams);
            this._editModel.setProperty("/selectedIbpStepParams", aParams);
        },

        onDeleteIbpStepParam: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            var iIdx = parseInt(oCtx.getPath().split("/").pop(), 10);
            var oCurIbp = this._currentIbpStep();
            if (!oCurIbp || isNaN(iIdx)) return;

            var aParams = (this._editModel.getProperty("/selectedIbpStepParams") || []).slice();
            var oParam = aParams[iIdx];
            var that = this;

            function doDelete() {
                aParams.splice(iIdx, 1);
                that._replaceIbpStepParams(oCurIbp.idx, aParams);
                that._editModel.setProperty("/selectedIbpStepParams", aParams);
            }

            // Warn before clearing a global variable slot in IBP
            if (oParam && oParam.ibpParamName) {
                var sVarName = oParam.key || oParam.ibpParamName;
                var sMsg;
                if (oParam.mandatory) {
                    sMsg = "\"" + sVarName + "\" is marked mandatory in IBP.\n" +
                           "Removing it will send an empty value and the job will fail.\n\nProceed anyway?";
                } else {
                    sMsg = "Removing \"" + sVarName + "\" will send an empty value to IBP.\n" +
                           "The job may fail if this variable is required by the integration step.\n\nProceed?";
                }
                var fnShow = oParam.mandatory ? MessageBox.error : MessageBox.warning;
                fnShow(sMsg, {
                    actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                    onClose: function (sAction) {
                        if (sAction === MessageBox.Action.OK) doDelete();
                    }
                });
            } else {
                doDelete();
            }
        },

        // Replace the params of IBP sub-step at iIbpIdx with a NEW array so the
        // composite binding on edit>ibpSteps in the DSP steps list re-evaluates.
        _replaceIbpStepParams: function (iIbpIdx, aParams) {
            // Update the working /ibpSteps list (new array → triggers binding refresh)
            var aIbp = (this._editModel.getProperty("/ibpSteps") || []).map(function (s, i) {
                return i === iIbpIdx ? Object.assign({}, s, { params: aParams }) : s;
            });
            this._editModel.setProperty("/ibpSteps", aIbp);
            // Mirror into the owning DSP step so the count survives step switching
            var oCurDsp = this._currentStep();
            if (oCurDsp) {
                var aDspIbp = (this._editModel.getProperty("/steps/" + oCurDsp.idx + "/ibpSteps") || []).map(function (s, i) {
                    return i === iIbpIdx ? Object.assign({}, s, { params: aParams }) : s;
                });
                this._editModel.setProperty("/steps/" + oCurDsp.idx + "/ibpSteps", aDspIbp);
            }
        },

        onToggleIbpParam: function (oEvt) {
            var oCtx = oEvt.getSource().getBindingContext("edit");
            if (!oCtx) return;
            var sPath = oCtx.getPath();
            var iIdx = parseInt(sPath.split("/").pop(), 10);
            var oCurIbp = this._currentIbpStep();
            if (!oCurIbp || isNaN(iIdx)) return;
            var aParams = (oCurIbp.step.params || []).slice();
            aParams[iIdx] = Object.assign({}, aParams[iIdx], { active: !aParams[iIdx].active });
            this._replaceIbpStepParams(oCurIbp.idx, aParams);
            this._editModel.setProperty("/selectedIbpStepParams", aParams);
        },

        onResetIbpNewParam: function () {
            this._editModel.setProperty("/newIbpParam", _newParam());
        },

        onIbpKeyValueHelp: function () {
            var oCurIbp = this._currentIbpStep();
            if (!oCurIbp) {
                MessageToast.show("Select an IBP step first");
                return;
            }

            // Global vars are per-step (extracted from that step's seq_param_val in IBP)
            var aGlobalVars = oCurIbp.step.globalVars || [];

            if (!aGlobalVars.length) {
                MessageToast.show("No global variables ($G_*) found for this IBP step");
                return;
            }

            var aDisplay = aGlobalVars;

            var that = this;
            var oVhModel = new JSONModel({ params: aDisplay });

            if (this._oIbpKeyVHD) {
                this._oIbpKeyVHD.setModel(oVhModel, "vh");
                this._oIbpKeyVHD.open();
                return;
            }

            sap.ui.require([
                "sap/m/SelectDialog",
                "sap/m/StandardListItem",
                "sap/ui/model/Filter",
                "sap/ui/model/FilterOperator"
            ], function (SelectDialog, StandardListItem, Filter, FilterOperator) {
                that._oIbpKeyVHD = new SelectDialog({
                    title: "Global Variables — IBP",
                    rememberSelections: false,
                    confirm: function (oEvt) {
                        var oItem = oEvt.getParameter("selectedItem");
                        if (oItem) {
                            var oCtx = oItem.getBindingContext("vh");
                            if (oCtx) {
                                that._editModel.setProperty("/newIbpParam/key", oCtx.getProperty("name"));
                                that._editModel.setProperty("/newIbpParam/ibpParamName", oCtx.getProperty("ibpParamName") || "");
                                that._editModel.setProperty("/newIbpParam/ibpVarNameParam", oCtx.getProperty("ibpVarNameParam") || "");
                                var sVal = oCtx.getProperty("currentValue");
                                if (sVal) {
                                    that._editModel.setProperty("/newIbpParam/value", sVal);
                                }
                            }
                        }
                    },
                    liveChange: function (oEvt) {
                        var sVal = oEvt.getParameter("value");
                        var oBinding = that._oIbpKeyVHD.getBinding("items");
                        if (oBinding) {
                            oBinding.filter(sVal ? [new Filter({
                                filters: [
                                    new Filter("name", FilterOperator.Contains, sVal),
                                    new Filter("label", FilterOperator.Contains, sVal),
                                    new Filter("currentValue", FilterOperator.Contains, sVal)
                                ],
                                and: false
                            })] : []);
                        }
                    }
                });
                that.getView().addDependent(that._oIbpKeyVHD);
                that._oIbpKeyVHD.setModel(oVhModel, "vh");
                that._oIbpKeyVHD.bindAggregation("items", {
                    path: "vh>/params",
                    template: new StandardListItem({
                        title: "{vh>name}",
                        description: "{vh>label}",
                        info: "{= ${vh>currentValue} ? ('IBP: ' + ${vh>currentValue}) : '—' }"
                    })
                });
                that._oIbpKeyVHD.open();
            });
        },

        formatStepParamCount: function (aParams, aIbpSteps) {
            var n = (aParams || []).length;
            (aIbpSteps || []).forEach(function (is) {
                n += (is.params || []).length;
            });
            return n + " params";
        },

        _buildSaveOutput: function (aSteps) {
            var oOut = {};
            aSteps.forEach(function (s) {
                var allParams = (s.params || []).filter(function (p) { return p.active !== false; });
                (s.ibpSteps || []).forEach(function (is) {
                    (is.params || []).filter(function (p) { return p.active !== false; }).forEach(function (p) {
                        allParams.push(Object.assign({}, p, { step: is.name }));
                    });
                });
                allParams = allParams.map(function (p) {
                    if (p.hierarchyId) {
                        var sVal = (p.value || "").trim();
                        if (sVal === "*" || sVal === "") {
                            return Object.assign({}, p, { value: "*" });
                        }
                        var aDatePath = _expandDateYYYYMM(sVal);
                        var memberIds = aDatePath ? [aDatePath] : [sVal];
                        return Object.assign({}, p, { value: JSON.stringify({ memberIds: memberIds, hierarchyId: p.hierarchyId }) });
                    }
                    return p;
                });
                if (allParams.length) {
                    var aToSave = s.sacMultiActionId
                        ? allParams.concat([{ key: "__sacMultiActionId", value: s.sacMultiActionId, active: true }])
                        : allParams;
                    oOut[s.name] = aToSave;
                }
            });
            return { oOut: oOut };
        },

        onSave: function () {
            var oComp = this.getOwnerComponent();
            var aSteps = this._editModel.getProperty("/steps") || [];
            var sTc = this._editModel.getProperty("/taskchain");
            var sTargetType = this._editModel.getProperty("/targetType") || "DSP";
            var sJobTemplate = this._editModel.getProperty("/jobTemplate") || "";
            var sCacheKey = sTargetType === "IBP" ? ("IBP:" + sJobTemplate) : sTc;

            var built = this._buildSaveOutput(aSteps);

            oComp._stepParamsState = {
                cacheKey: sCacheKey,
                taskchain: sTc,
                parametersJson: JSON.stringify(built.oOut),
                _fresh: true
            };

            var sReturnTo = this._editModel.getProperty("/returnTo") || "scheduleList";
            var oReturnQuery = this._editModel.getProperty("/returnQuery") || {};
            MessageToast.show("Step parameters saved");
            this.getRouter().navTo(sReturnTo, { "?query": oReturnQuery }, true);
        }
    });
});
