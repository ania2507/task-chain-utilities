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
                selectedStepIntegrationType: "",
                selectedStepParams: [],
                newParam: _newParam(),
                busy: false,
                ibpTemplateName: "",
                ibpTemplateNameInput: "",
                ibpTemplateNameIsOverride: false,
                ibpTemplateDescription: "",
                ibpSteps: [],
                ibpLoading: false,
                ibpTemplatesLoading: false,
                ibpGlobalVars: [],
                selectedIbpStepIdx: null,
                selectedIbpStepName: "",
                selectedIbpStepParams: [],
                ibpParamsLocked: false,
                ibpParamCount: 0,
                ibpMaxParamCount: 0,
                newIbpParam: _newParam(),
                sacMultiActionId: "",
                sacMultiActionIdInput: "",
                sacMultiActionIdIsOverride: false,
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
                selectedStepIntegrationType: "",
                selectedStepParams: [],
                newParam: _newParam(),
                busy: true,
                ibpTemplateName: "",
                ibpTemplateNameInput: "",
                ibpTemplateNameIsOverride: false,
                ibpTemplateDescription: "",
                ibpSteps: [],
                ibpLoading: false,
                ibpTemplatesLoading: false,
                ibpGlobalVars: [],
                selectedIbpStepIdx: null,
                selectedIbpStepName: "",
                selectedIbpStepParams: [],
                ibpParamsLocked: false,
                ibpParamCount: 0,
                ibpMaxParamCount: 0,
                newIbpParam: _newParam(),
                sacMultiActionId: "",
                sacMultiActionIdInput: "",
                sacMultiActionIdIsOverride: false,
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
            fetch(that._getApiBase() + "jobs/ibp/template-steps", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ template_name: sTemplateName })
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    that._applyIbpParamSizeGuard(data, /*bShowMessage*/ true);
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
            var sDagUrl = that._getApiBase() + "dsp/taskchain-dag?spaceId=" + encodeURIComponent(sSpaceId)
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
                                    // No DSP auto-detection for the IBP job template or the SAC
                                    // multi action anymore - both are always set directly in this
                                    // app (see onSelectIbpTemplate / the template search, and
                                    // onInsertSacMultiAction / onLoadSacMultiAction), never
                                    // inherited from DSP's own step config. Parameters/sequences
                                    // still come live from IBP/SAC once an ID is known - unchanged.
                                    ibpTemplateName: "",
                                    sacMultiActionId: "",
                                    integrationType: n.integrationType || "",
                                    objectType: n.objectType || "",
                                    isSkipStep: !!n.isSkipStep,
                                    allowParams: true,
                                    params: []
                                };
                            });
                    }
                    if (aSteps.length) {
                        return aSteps;
                    }
                    // 2. Fallback: query distinct steps from execution logs.
                    var sStepsUrl = that._getApiBase() + "dsp/taskchain-steps?spaceId=" + encodeURIComponent(sSpaceId)
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
                                        ibpTemplateName: "", // no DSP auto-detection - see comment above
                                        sacMultiActionId: "", // no DSP auto-detection - see comment above
                                        integrationType: s.integrationType || "",
                                        objectType: s.objectType || "",
                                        isSkipStep: !!s.isSkipStep,
                                        allowParams: true,
                                        params: []
                                    };
                                });
                            }
                            return [];
                        });
                })
                .then(function (aSteps) {
                    // Neither IBP job templates nor SAC multi actions are auto-detected
                    // from DSP anymore - both are always set directly in this app.
                    that._editModel.setProperty("/steps", aSteps || []);
                    that._applyParamsJsonToSteps();
                    // Read back from the model (not the stale aSteps closure) so a restored
                    // override is honored by the preload loop below.
                    var aMergedSteps = that._editModel.getProperty("/steps") || [];
                    var bHasSac = aMergedSteps.some(function (s) { return !!s.sacMultiActionId; });
                    that._editModel.setProperty("/hasSacSteps", bHasSac);
                    // Pre-load IBP sub-steps in background so param count is visible immediately
                    aMergedSteps.forEach(function (step, idx) {
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
            // Resolve the template description in the background too — this preload
            // path runs for steps whose template came from a saved/Excel-imported
            // override, which doesn't go through the value-help dialog that would
            // otherwise populate the description.
            this._resolveIbpTemplateDescription(sTemplate).then(function (sDescription) {
                if (!sDescription) return;
                var aSteps = that._editModel.getProperty("/steps") || [];
                if (iDspIdx < aSteps.length && !aSteps[iDspIdx].ibpTemplateDescription) {
                    that._editModel.setProperty("/steps/" + iDspIdx + "/ibpTemplateDescription", sDescription);
                    var oCurNow = that._currentStep();
                    if (oCurNow && oCurNow.idx === iDspIdx) {
                        that._editModel.setProperty("/ibpTemplateDescription", sDescription);
                    }
                }
            });
            fetch(that._getApiBase() + "jobs/ibp/template-steps", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ template_name: sTemplate })
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (data.error) return;
                    var bLockedPreload = that._applyIbpParamSizeGuard(data, /*bShowMessage*/ false, iDspIdx);
                    // Consume _restoredIbpParams here (inside the .then) so that
                    // _doLoadIbpSteps triggered by the user clicking a step before
                    // this response arrives can still read and consume it first.
                    // Keyed by "name::occurrenceIndex" (not just name) — the same IBP
                    // operator name can appear more than once in a template's sequence,
                    // at different positions, each with its own distinct params.
                    var oRestored = that._restoredIbpParams && that._restoredIbpParams[sStepName];
                    if (oRestored) {
                        delete that._restoredIbpParams[sStepName];
                    }
                    var oExistingByKey = that._resolveRestoredParamsMap(oRestored, data.steps);
                    var aStepKeys = that._buildIbpStepKeys(data.steps);
                    var aIbpSteps = (Array.isArray(data.steps) ? data.steps : []).map(function (s, i) {
                        // Locked template: force an empty param list (see the fuller
                        // explanation on the equivalent check in _doLoadIbpSteps below).
                        if (bLockedPreload) {
                            return Object.assign({}, s, { params: [] });
                        }
                        var aExisting = oExistingByKey[aStepKeys[i]] || [];
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
                // Set immediately (not just on success) so the probing-retry guard below,
                // which compares against /sacMultiActionId, keeps tracking this same load
                // even if the user switched from a different auto-detected/overridden ID.
                this._editModel.setProperty("/sacMultiActionId", sSacId);
                this._editModel.setProperty("/sacMultiActionIdInput", sSacId);
            }
            fetch(that._getApiBase() + "jobs/sac/multiaction-parameters/" + encodeURIComponent(sSacId), {
                headers: { "Accept": "application/json" }
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (data.error) {
                        that._editModel.setProperty("/sacLoading", false);
                        MessageToast.show("SAC error: " + data.error);
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
                    // Mirror the (manually-entered) multiaction ID onto the persistent step
                    // object so it survives step-switching and feeds into _buildSaveOutput.
                    if (oCur) {
                        that._editModel.setProperty("/steps/" + oCur.idx + "/sacMultiActionId", sSacId);
                    }
                    that._editModel.setProperty("/sacLoading", false);
                })
                .catch(function () {
                    that._editModel.setProperty("/sacLoading", false);
                });
        },

        onLoadSacMultiAction: function () {
            if (this._editModel.getProperty("/viewOnly")) return;
            var sId = (this._editModel.getProperty("/sacMultiActionIdInput")
                || this._editModel.getProperty("/sacMultiActionId") || "").trim();
            if (!sId) {
                MessageToast.show("Enter a Multi Action ID first");
                return;
            }
            var that = this;
            MessageBox.confirm(
                "This will run a real execution of multi action \"" + sId + "\" in SAC to discover its "
                + "parameters. Continue?",
                {
                    title: "Run SAC Multi Action?",
                    actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                    emphasizedAction: MessageBox.Action.OK,
                    onClose: function (sAction) {
                        if (sAction !== MessageBox.Action.OK) return;
                        that._doLoadSacMultiAction(sId);
                    }
                }
            );
        },

        _doLoadSacMultiAction: function (sId) {
            var sCurrent = this._editModel.getProperty("/sacMultiActionId") || "";
            if (sId !== sCurrent) {
                // Switching to a different multi action: drop params tied to the old one so
                // _loadSacParameters always (re-)derives them by launching the new ID and
                // reading its validation error, rather than keeping stale values around.
                var oCur = this._currentStep();
                if (oCur) { this._editModel.setProperty("/steps/" + oCur.idx + "/params", []); }
                this._editModel.setProperty("/selectedStepParams", []);
            }
            this._loadSacParameters(sId);
        },

        // "Insert" — associate the step with this multi action ID without running
        // SAC's parameter-discovery simulation (onLoadSacMultiAction/_loadSacParameters).
        // For multi actions with no mandatory parameters, this avoids an unnecessary
        // wait: the user can just insert the ID and save.
        onInsertSacMultiAction: function () {
            if (this._editModel.getProperty("/viewOnly")) return;
            var sId = (this._editModel.getProperty("/sacMultiActionIdInput") || "").trim();
            if (!sId) {
                MessageToast.show("Enter a Multi Action ID first");
                return;
            }
            var sCurrent = this._editModel.getProperty("/sacMultiActionId") || "";
            var oCur = this._currentStep();
            if (sId !== sCurrent) {
                if (oCur) { this._editModel.setProperty("/steps/" + oCur.idx + "/params", []); }
                this._editModel.setProperty("/selectedStepParams", []);
            }
            this._editModel.setProperty("/sacMultiActionId", sId);
            this._editModel.setProperty("/sacMultiActionIdInput", sId);
            this._editModel.setProperty("/sacMultiActionName", "");
            this._editModel.setProperty("/sacParamSchema", []);
            this._editModel.setProperty("/sacNoParameters", false);
            this._editModel.setProperty("/sacParamSchemaUnavailable", false);
            if (oCur) {
                this._editModel.setProperty("/steps/" + oCur.idx + "/sacMultiActionId", sId);
            }
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
            if (oQuery.spaceId)    out.spaceId    = oQuery.spaceId;
            if (oQuery.taskchain)  out.taskchain  = oQuery.taskchain;
            if (oQuery.name)       out.name       = oQuery.name;
            if (oQuery.scheduleID) out.scheduleID = oQuery.scheduleID;
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

                    // Restore the saved IBP job template name, if stashed (this is the only
                    // source now - no DSP auto-detection to fall back to or override).
                    var oIbpOverrideRow = allParams.filter(function (p) {
                        return p.key === "__ibpTemplateNameOverride";
                    })[0];
                    if (oIbpOverrideRow && oIbpOverrideRow.value) {
                        step = Object.assign({}, step, { ibpTemplateName: oIbpOverrideRow.value });
                    }
                    // Restore the (possibly user-edited) job name - takes priority over
                    // the auto-fetched template description (see _doLoadIbpSteps /
                    // _preloadIbpStepsForDspStep, which only auto-fetch when this is empty).
                    var oJobTextOverrideRow = allParams.filter(function (p) {
                        return p.key === "__ibpJobTextOverride";
                    })[0];
                    if (oJobTextOverrideRow && oJobTextOverrideRow.value) {
                        step = Object.assign({}, step, { ibpTemplateDescription: oJobTextOverrideRow.value });
                    }
                    var oSacOverrideRow = allParams.filter(function (p) {
                        return p.key === "__sacMultiActionIdOverride";
                    })[0];
                    if (oSacOverrideRow && oSacOverrideRow.value) {
                        step = Object.assign({}, step, { sacMultiActionId: oSacOverrideRow.value });
                    }
                    // Excel bulk-import rows that specify only a job template with no
                    // individual parameter values carry this sentinel — default that
                    // step to "Usa Default" (unless the template turns out to be over
                    // the size threshold, which forces it regardless and disables the
                    // toggle; below threshold the user can still switch it back off).
                    var oUseDefaultsRow = allParams.filter(function (p) {
                        return p.key === "__ibpUseDefaults";
                    })[0];
                    if (oUseDefaultsRow && oUseDefaultsRow.value === "true") {
                        step = Object.assign({}, step, { ibpUseDefaults: true });
                    }

                    // Any "__"-prefixed key is internal bookkeeping (recomputed fresh at save
                    // time, or restored above into dedicated step fields) — never show it as a
                    // visible key/value row.
                    var dspParams = allParams.filter(function (p) {
                        return !p.step && !String(p.key || "").startsWith("__");
                    });
                    // IBP sub-step params → stored in _restoredIbpParams, not in ibpSteps,
                    // so _doLoadIbpSteps still fetches all template steps from IBP.
                    // Kept under two keys: "name::occurrenceIndex" (precise — the same IBP
                    // operator name can repeat at different positions in a template's
                    // sequence, and the Nth occurrence in the file/save maps to the Nth
                    // occurrence in the template) and a name-only bucket for older saves
                    // that predate stepOccurrence, used as a fallback only when that name
                    // turns out to be unambiguous (see _resolveRestoredParamsMap).
                    allParams.filter(function (p) { return p.step; }).forEach(function (p) {
                        if (!that._restoredIbpParams[step.name]) {
                            that._restoredIbpParams[step.name] = { byKey: {}, byNameOnly: {} };
                        }
                        var oBucket = that._restoredIbpParams[step.name];
                        var oEntry = { key: p.key, value: p.value, active: p.active !== false, description: p.description || "", ibpParamName: p.ibpParamName || "", ibpVarNameParam: p.ibpVarNameParam || "", mandatory: !!p.mandatory };
                        var sCompositeKey = that._ibpStepKeyFor(p.step, p.stepOccurrence);
                        if (!oBucket.byKey[sCompositeKey]) oBucket.byKey[sCompositeKey] = [];
                        oBucket.byKey[sCompositeKey].push(oEntry);
                        if (!oBucket.byNameOnly[p.step]) oBucket.byNameOnly[p.step] = [];
                        oBucket.byNameOnly[p.step].push(oEntry);
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
                this._editModel.setProperty("/selectedStepIntegrationType", "");
                this._editModel.setProperty("/selectedStepParams", []);
                this._editModel.setProperty("/ibpTemplateName", "");
                this._editModel.setProperty("/ibpTemplateNameInput", "");
                this._editModel.setProperty("/ibpTemplateNameIsOverride", false);
                this._editModel.setProperty("/ibpTemplateDescription", "");
                this._editModel.setProperty("/ibpSteps", []);
                this._editModel.setProperty("/ibpLoading", false);
                this._editModel.setProperty("/selectedIbpStepIdx", null);
                this._editModel.setProperty("/selectedIbpStepName", "");
                this._editModel.setProperty("/selectedIbpStepParams", []);
                this._editModel.setProperty("/sacMultiActionId", "");
                this._editModel.setProperty("/sacMultiActionIdInput", "");
                this._editModel.setProperty("/sacMultiActionIdIsOverride", false);
                this._editModel.setProperty("/sacMultiActionName", "");
                return;
            }

            var aCachedIbpSteps = oStep.ibpSteps || [];
            this._editModel.setProperty("/selectedStepId", oStep.id);
            this._editModel.setProperty("/selectedStepName", oStep.order + ": " + sDisplayName);
            this._editModel.setProperty("/selectedStepIsBlocked", false);
            this._editModel.setProperty("/selectedStepIntegrationType", oStep.integrationType || "");
            this._editModel.setProperty("/selectedStepParams", (oStep.params || []).filter(function (p) {
                return !String(p.key || "").startsWith("__");
            }));
            this._editModel.setProperty("/newParam", _newParam());
            this._editModel.setProperty("/ibpTemplateName", oStep.ibpTemplateName || "");
            this._editModel.setProperty("/ibpTemplateNameInput", oStep.ibpTemplateName || "");
            this._editModel.setProperty("/ibpTemplateNameIsOverride", !!oStep.ibpTemplateNameIsOverride);
            this._editModel.setProperty("/ibpTemplateDescription", oStep.ibpTemplateDescription || "");
            // Restore this step's own param-size-guard state (set the last time its
            // template was loaded, or by an Excel import's __ibpUseDefaults sentinel)
            // BEFORE _doLoadIbpSteps below can overwrite it - that call only resets
            // ibpUseDefaults when it finds no prior value, so setting it here first
            // means an already-known "Usa Default" choice survives switching steps.
            this._editModel.setProperty("/ibpParamsLocked", !!oStep.ibpParamsLocked);
            this._editModel.setProperty("/ibpParamCount", oStep.ibpParamCount || 0);
            this._editModel.setProperty("/ibpMaxParamCount", oStep.ibpMaxParamCount || 0);
            this._editModel.setProperty("/ibpUseDefaults", !!oStep.ibpUseDefaults);
            this._editModel.setProperty("/ibpSteps", aCachedIbpSteps);
            this._editModel.setProperty("/ibpLoading", false);
            this._editModel.setProperty("/selectedIbpStepIdx", null);
            this._editModel.setProperty("/selectedIbpStepName", "");
            this._editModel.setProperty("/selectedIbpStepParams", []);
            this._editModel.setProperty("/newIbpParam", _newParam());
            this._editModel.setProperty("/sacMultiActionId", oStep.sacMultiActionId || "");
            this._editModel.setProperty("/sacMultiActionIdInput", oStep.sacMultiActionId || "");
            this._editModel.setProperty("/sacMultiActionIdIsOverride", !!oStep.sacMultiActionIdIsOverride);
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
        //
        // Exception: "skip override" steps call this app's own /v1/taskchains/skip
        // endpoint directly (not /v1/jobs/launch) — they never have an IBP template
        // or SAC multi action, so this association UI must never be offered for them.
        // Detected server-side from the step's own configured request in the DWC
        // deployment metadata (isSkipStep), not guessed from its DSP name.
        _isApiStep: function (oStep) {
            if (!oStep) return false;
            if (oStep.isSkipStep) return false;
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
                active: !!oNew.active,
                description: oNew.description || "",
                hierarchyId: oNew.hierarchyId || ""
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
                key: oRow.key, value: oRow.value, active: !!oRow.active,
                description: oRow.description || "", hierarchyId: oRow.hierarchyId || ""
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
            if (this._editModel.getProperty("/viewOnly")) return;
            var sTemplate = (this._editModel.getProperty("/ibpTemplateNameInput")
                || this._editModel.getProperty("/ibpTemplateName") || "").trim();
            if (!sTemplate) {
                MessageToast.show("Enter an IBP template name first");
                return;
            }
            this._doLoadIbpSteps(sTemplate);
        },

        // Resolve an IBP template's description from the template catalog cache. The
        // cache is normally populated by opening the value-help search dialog, but a
        // manually typed/inserted template name (the override flow, or one loaded
        // from a saved/Excel-imported override) may run before that ever happens —
        // fetch the catalog on demand in that case instead of leaving it blank.
        _resolveIbpTemplateDescription: function (sTemplate) {
            var that = this;
            var pTemplatesCache = this._aIbpTemplatesCache
                ? Promise.resolve(this._aIbpTemplatesCache)
                : fetch(that._getApiBase() + "jobs/ibp/templates", { headers: { "Accept": "application/json" } })
                    .then(function (res) { return res.json(); })
                    .then(function (data) {
                        that._aIbpTemplatesCache = data.templates || [];
                        return that._aIbpTemplatesCache;
                    })
                    .catch(function () { return []; });
            return pTemplatesCache.then(function (aTemplates) {
                var oCacheMatch = (aTemplates || []).filter(function (t) {
                    return t.name === sTemplate;
                })[0];
                return oCacheMatch ? (oCacheMatch.description || "") : "";
            });
        },

        _doLoadIbpSteps: function (sTemplate) {
            var that = this;
            // Guard against out-of-order responses: if the template is changed and
            // "refresh" is clicked again before the previous request for the OLD
            // template comes back, that stale response must not be allowed to
            // overwrite the newer one once it does arrive.
            var iSeq = (this._ibpStepsLoadSeq = (this._ibpStepsLoadSeq || 0) + 1);
            this._resolveIbpTemplateDescription(sTemplate).then(function (sDescription) {
                if (iSeq !== that._ibpStepsLoadSeq) return;
                that._editModel.setProperty("/ibpTemplateDescription", sDescription);
                var oCurNow = that._currentStep();
                if (oCurNow && oCurNow.step.ibpTemplateName === sTemplate) {
                    that._editModel.setProperty("/steps/" + oCurNow.idx + "/ibpTemplateDescription", sDescription);
                }
            });
            // Capture existing params BEFORE clearing /ibpSteps.
            // Priority: cached ibpSteps on the current DSP step (survive step-switching),
            // falling back to the current /ibpSteps working list.
            var oCurPre = this._currentStep();
            var aPre = (oCurPre && this._editModel.getProperty("/steps/" + oCurPre.idx + "/ibpSteps"))
                || this._editModel.getProperty("/ibpSteps") || [];
            // Keyed by "name::occurrenceIndex" — the same IBP operator name can appear
            // more than once in a template's sequence, at different positions, each
            // with its own distinct params (keying by name alone would merge them).
            var oExistingByKey = {};
            var aPreKeys = this._buildIbpStepKeys(aPre);
            aPre.forEach(function (s, i) { oExistingByKey[aPreKeys[i]] = s.params || []; });

            this._editModel.setProperty("/ibpLoading", true);
            this._editModel.setProperty("/ibpSteps", []);
            var oCurForRestore = this._currentStep();
            var oRestoredForStep = oCurForRestore && this._restoredIbpParams
                && this._restoredIbpParams[oCurForRestore.step.name];
            if (oRestoredForStep && oCurForRestore) {
                delete this._restoredIbpParams[oCurForRestore.step.name];
            }
            fetch(that._getApiBase() + "jobs/ibp/template-steps", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ template_name: sTemplate })
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (iSeq !== that._ibpStepsLoadSeq) return; // superseded by a newer load
                    if (data.error) {
                        MessageToast.show("IBP error: " + data.error);
                        return;
                    }
                    var bLockedForLoad = that._applyIbpParamSizeGuard(data, /*bShowMessage*/ true,
                        oCurForRestore ? oCurForRestore.idx : null);
                    // Store global vars ($G_*) at template level for the match code
                    var aTemplateGlobalVars = data.globalVars || [];
                    that._editModel.setProperty("/ibpGlobalVars", aTemplateGlobalVars);
                    // Resolve restored (from saved parametersJson) params now that the
                    // fetched steps' names/order are known, so the name-only legacy
                    // fallback can safely apply only when unambiguous.
                    if (oRestoredForStep) {
                        var oResolved = that._resolveRestoredParamsMap(oRestoredForStep, data.steps);
                        Object.keys(oResolved).forEach(function (k) {
                            if (!oExistingByKey[k] || !oExistingByKey[k].length) {
                                oExistingByKey[k] = oResolved[k];
                            }
                        });
                    }
                    var aFreshKeys = that._buildIbpStepKeys(data.steps);
                    var aSteps = (Array.isArray(data.steps) ? data.steps : []).map(function (s, i) {
                        // Locked templates always launch with zero parameters, and editing
                        // is disabled - so a leftover active param here could never be
                        // cleared by the user and would permanently block onSave's guard.
                        // Force an empty list regardless of where params would have come from.
                        if (bLockedForLoad) {
                            return Object.assign({}, s, { params: [] });
                        }
                        var aExisting = oExistingByKey[aFreshKeys[i]] || [];
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
                    // Mirror the loaded template name so CASE 2 renders even when reached
                    // via CASE 1's manual "Load" entry point (where /ibpTemplateName was empty).
                    that._editModel.setProperty("/ibpTemplateName", sTemplate);
                    that._editModel.setProperty("/ibpTemplateNameInput", sTemplate);
                    // Persist in the current DSP step so switching steps doesn't lose params
                    var oCur = that._currentStep();
                    if (oCur) {
                        that._editModel.setProperty("/steps/" + oCur.idx + "/ibpSteps", aSteps);
                        // No DSP baseline to diff against - the template name set here is
                        // simply what this step uses, always persisted (see _buildSaveOutput).
                        that._editModel.setProperty("/steps/" + oCur.idx + "/ibpTemplateName", sTemplate);
                        that._editModel.setProperty("/steps/" + oCur.idx + "/ibpTemplateDescription",
                            that._editModel.getProperty("/ibpTemplateDescription") || "");
                    }
                })
                .catch(function (e) {
                    if (iSeq !== that._ibpStepsLoadSeq) return; // superseded by a newer load
                    MessageToast.show("Failed to load IBP template: " + e.message);
                })
                .finally(function () {
                    if (iSeq !== that._ibpStepsLoadSeq) return; // let the newer load's own .finally() clear busy
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
            fetch(that._getApiBase() + "dsp/task-global-vars?taskName=" + encodeURIComponent(sTaskName), {
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

        // The same IBP operator name can repeat at different positions in a
        // template's sequence. Disambiguate by occurrence index (how many earlier
        // entries already had this name, 0-based) so it lines up with the Excel
        // bulk-import row order (see CustomCalendarPage's Parameters-sheet parsing).
        _buildIbpStepOccurrences: function (aSteps) {
            var oCounts = {};
            return (aSteps || []).map(function (s) {
                var sName = (s && s.name) || "";
                var n = oCounts[sName] || 0;
                oCounts[sName] = n + 1;
                return n;
            });
        },

        _ibpStepKeyFor: function (sName, nOccurrence) {
            return (sName || "") + "::" + (nOccurrence != null ? nOccurrence : "");
        },

        // Returns an array of "name::occurrenceIndex" keys, one per entry in aSteps,
        // in the same order.
        _buildIbpStepKeys: function (aSteps) {
            var that = this;
            var aOcc = this._buildIbpStepOccurrences(aSteps);
            return (aSteps || []).map(function (s, i) {
                return that._ibpStepKeyFor(s && s.name, aOcc[i]);
            });
        },

        // Resolves a saved { byKey, byNameOnly } restore bucket (see
        // _applyParamsJsonToSteps) into a flat "name::occurrenceIndex" -> params map,
        // given the freshly-fetched IBP template steps. Falls back to the name-only
        // bucket (older saves made before stepOccurrence existed) only when that name
        // is unambiguous in the current fetch — never guesses when duplicates are present.
        _resolveRestoredParamsMap: function (oRestored, aFetchedSteps) {
            if (!oRestored) return {};
            var oNameCounts = {};
            (aFetchedSteps || []).forEach(function (s) {
                oNameCounts[s.name] = (oNameCounts[s.name] || 0) + 1;
            });
            var aKeys = this._buildIbpStepKeys(aFetchedSteps);
            var oOut = Object.assign({}, oRestored.byKey);
            (aFetchedSteps || []).forEach(function (s, i) {
                var sKey = aKeys[i];
                if ((!oOut[sKey] || !oOut[sKey].length) && oNameCounts[s.name] === 1 && oRestored.byNameOnly[s.name]) {
                    oOut[sKey] = oRestored.byNameOnly[s.name];
                }
            });
            return oOut;
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

        /**
         * Reads the template-size fields from a /ibp/template-steps response
         * (paramCount / maxParamCount / tooManyParams — see jobs.py's
         * _IBP_MAX_PARAM_COUNT) and locks parameter editing when the
         * template is too large for IBP to reliably apply a partial
         * override. IBP's JobSchedule call puts every parameter in the URL,
         * which is rejected above IBP's own gateway limit — and testing
         * showed a partial override isn't honored reliably either, so past
         * that size the only safe option is to always launch with none.
         */
        _applyIbpParamSizeGuard: function (data, bShowMessage, iDspIdx) {
            var that = this;
            var bLocked = !!data.tooManyParams;
            var sTemplateName = data.template_name || "";

            // "Usa Default" is a property of the IBP job template, not of any one
            // DSP step: the same template can be referenced by more than one step
            // in a chain, and toggling it (or hitting the size lock) for one of
            // them must be reflected in all of them, never decided independently
            // per occurrence.
            var aSteps = this._editModel.getProperty("/steps") || [];
            var bExistingUseDefaults;
            if (sTemplateName) {
                aSteps.forEach(function (s) {
                    if (s.ibpTemplateName === sTemplateName && s.ibpUseDefaults !== undefined) {
                        bExistingUseDefaults = s.ibpUseDefaults;
                    }
                });
            }
            // Locked templates always use defaults, forced and non-optional. Below
            // the threshold, any existing choice for this template (from another
            // occurrence, or a previous load) is carried over so it survives
            // reloads and stays identical everywhere the template is used.
            var bUseDefaults = bLocked ? true : (bExistingUseDefaults !== undefined ? bExistingUseDefaults : false);

            this._editModel.setProperty("/ibpParamsLocked", bLocked);
            this._editModel.setProperty("/ibpParamCount", data.paramCount || 0);
            this._editModel.setProperty("/ibpMaxParamCount", data.maxParamCount || 0);
            this._editModel.setProperty("/ibpUseDefaults", bUseDefaults);

            // Mirror onto every DSP step that references this same template (not
            // just whichever one triggered this load) so onSave() validates every
            // step consistently and the switch reads identically everywhere.
            // iDspIdx (the step that triggered this load) is always included even
            // when its /ibpTemplateName in the model hasn't been updated to
            // sTemplateName yet - on a fresh manual "Load", that write happens
            // after this call returns, so relying on the name match alone would
            // silently skip mirroring onto the very step that just loaded it.
            var oMirrored = {};
            var mirrorOnto = function (i) {
                if (oMirrored[i]) return;
                oMirrored[i] = true;
                var sBase = "/steps/" + i;
                that._editModel.setProperty(sBase + "/ibpParamsLocked", bLocked);
                that._editModel.setProperty(sBase + "/ibpParamCount", data.paramCount || 0);
                that._editModel.setProperty(sBase + "/ibpMaxParamCount", data.maxParamCount || 0);
                that._editModel.setProperty(sBase + "/ibpUseDefaults", bUseDefaults);
            };
            if (iDspIdx !== null && iDspIdx !== undefined) {
                mirrorOnto(iDspIdx);
            }
            if (sTemplateName) {
                aSteps.forEach(function (s, i) {
                    if (s.ibpTemplateName === sTemplateName) mirrorOnto(i);
                });
            }

            if (bLocked && bShowMessage && this._sParamsLockWarnedFor !== sTemplateName) {
                this._sParamsLockWarnedFor = sTemplateName;
                MessageBox.warning(
                    "This job template is too large to support custom parameters. "
                    + "\"Use Default\" has been switched on automatically and parameter "
                    + "editing is disabled for this template — IBP will use its own saved "
                    + "defaults for every run.",
                    { title: "Template too large for custom parameters" }
                );
            }
            return bLocked;
        },

        /**
         * Handler for the "Usa Default" switch. Below the param-count threshold
         * this is the user's free choice; above it, the switch is disabled in
         * the view so this handler can never fire with bLocked true anyway —
         * still guarded here in case a binding update races ahead of that.
         */
        onToggleIbpUseDefaults: function (oEvt) {
            if (this._editModel.getProperty("/ibpParamsLocked")) {
                return; // locked templates can't turn this off - view already disables the control
            }
            var bState = oEvt.getParameter("state");
            this._editModel.setProperty("/ibpUseDefaults", bState);
            var oCur = this._currentStep();
            var sTemplateName = oCur && oCur.step && oCur.step.ibpTemplateName;
            // The flag belongs to the template, not this one step occurrence - mirror
            // it onto every other DSP step that references the same IBP template.
            if (sTemplateName) {
                var aSteps = this._editModel.getProperty("/steps") || [];
                aSteps.forEach(function (s, i) {
                    if (s.ibpTemplateName === sTemplateName) {
                        this._editModel.setProperty("/steps/" + i + "/ibpUseDefaults", bState);
                    }
                }, this);
            } else if (oCur) {
                this._editModel.setProperty("/steps/" + oCur.idx + "/ibpUseDefaults", bState);
            }
        },

        // "Job Name" field: pre-filled from the template's own description but
        // editable per DSP step (not shared across steps like the template name -
        // each occurrence of a template represents its own job run and can have
        // its own name). Mirrors onto the owning step so it survives step-switching
        // and reaches _buildSaveOutput.
        onIbpJobTextChange: function (oEvt) {
            var sValue = (oEvt.getParameter("value") || "").trim();
            this._editModel.setProperty("/ibpTemplateDescription", sValue);
            var oCur = this._currentStep();
            if (oCur) {
                this._editModel.setProperty("/steps/" + oCur.idx + "/ibpTemplateDescription", sValue);
            }
        },

        onAddIbpStepParam: function () {
            if (this._editModel.getProperty("/ibpParamsLocked")) {
                MessageToast.show("This template has too many parameters — customization is disabled.");
                return;
            }
            var oNew = this._editModel.getProperty("/newIbpParam") || {};
            if (!oNew.key || !String(oNew.key).trim()) {
                MessageToast.show("Param Key is required");
                return;
            }
            var oCurIbp = this._currentIbpStep();
            if (!oCurIbp) { MessageToast.show("Select an IBP step first"); return; }

            // "Match code" guard: only accept keys that resolve to a real global
            // variable known for this step (the same list the Value Help dialog
            // offers) — free-typed names that don't match anything never reach
            // IBP as a working override, they just fail silently at launch time.
            var sKeyTrim = String(oNew.key).trim();
            var aKnownVars = oCurIbp.step.globalVars || [];
            var oMatch = aKnownVars.filter(function (g) {
                return g.name === sKeyTrim
                    || (oNew.ibpParamName && g.ibpParamName === oNew.ibpParamName);
            })[0];
            if (!oMatch) {
                MessageBox.error(
                    "\"" + sKeyTrim + "\" does not match a known global variable for this "
                    + "IBP step. Use the match-code button (value help) to pick a valid "
                    + "parameter instead of typing a custom name.",
                    { title: "Unknown parameter" }
                );
                return;
            }

            var aParams = (oCurIbp.step.params || []).slice();
            aParams.push({ key: sKeyTrim, value: oNew.value == null ? "" : String(oNew.value), active: true, description: oMatch.label || oNew.description || "", ibpParamName: oMatch.ibpParamName || oNew.ibpParamName || "", ibpVarNameParam: oMatch.ibpVarNameParam || oNew.ibpVarNameParam || "" });
            this._replaceIbpStepParams(oCurIbp.idx, aParams);
            this._editModel.setProperty("/selectedIbpStepParams", aParams);
            this._editModel.setProperty("/newIbpParam", _newParam());
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

        onIbpTemplateValueHelp: function () {
            if (this._editModel.getProperty("/viewOnly")) return;
            var that = this;

            function openWith(aTemplates) {
                var oVhModel = new JSONModel({ templates: aTemplates });
                if (that._oIbpTemplateVHD) {
                    that._oIbpTemplateVHD.setModel(oVhModel, "vh");
                    that._oIbpTemplateVHD.open();
                    return;
                }
                sap.ui.require([
                    "sap/m/SelectDialog",
                    "sap/m/StandardListItem",
                    "sap/ui/model/Filter",
                    "sap/ui/model/FilterOperator"
                ], function (SelectDialog, StandardListItem, Filter, FilterOperator) {
                    that._oIbpTemplateVHD = new SelectDialog({
                        title: "IBP Job Templates",
                        rememberSelections: false,
                        confirm: function (oEvt) {
                            var oItem = oEvt.getParameter("selectedItem");
                            if (!oItem) return;
                            var oCtx = oItem.getBindingContext("vh");
                            if (!oCtx) return;
                            var sName = oCtx.getProperty("name");
                            that._editModel.setProperty("/ibpTemplateNameInput", sName);
                            that._editModel.setProperty("/ibpTemplateDescription", oCtx.getProperty("description") || "");
                            that._doLoadIbpSteps(sName);
                        },
                        liveChange: function (oEvt) {
                            var sVal = oEvt.getParameter("value");
                            var oBinding = that._oIbpTemplateVHD.getBinding("items");
                            if (oBinding) {
                                oBinding.filter(sVal ? [new Filter({
                                    filters: [
                                        new Filter("name", FilterOperator.Contains, sVal),
                                        new Filter("description", FilterOperator.Contains, sVal)
                                    ],
                                    and: false
                                })] : []);
                            }
                        }
                    });
                    that.getView().addDependent(that._oIbpTemplateVHD);
                    that._oIbpTemplateVHD.setModel(oVhModel, "vh");
                    that._oIbpTemplateVHD.bindAggregation("items", {
                        path: "vh>/templates",
                        template: new StandardListItem({
                            title: "{vh>name}",
                            description: "{vh>description}"
                        })
                    });
                    that._oIbpTemplateVHD.open();
                });
            }

            if (this._aIbpTemplatesCache) {
                openWith(this._aIbpTemplatesCache);
                return;
            }

            this._editModel.setProperty("/ibpTemplatesLoading", true);
            fetch(that._getApiBase() + "jobs/ibp/templates", {
                headers: { "Accept": "application/json" }
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (data.error) {
                        MessageToast.show("IBP error: " + data.error);
                        return;
                    }
                    that._aIbpTemplatesCache = data.templates || [];
                    openWith(that._aIbpTemplatesCache);
                })
                .catch(function (e) {
                    MessageToast.show("Failed to load IBP templates: " + e.message);
                })
                .finally(function () {
                    that._editModel.setProperty("/ibpTemplatesLoading", false);
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
            var that = this;
            aSteps.forEach(function (s) {
                var allParams = (s.params || []).filter(function (p) { return p.active !== false; });
                // stepOccurrence disambiguates IBP operator names that repeat within the
                // same template's sequence — "the Nth step named X", not an absolute
                // position — so it lines up with the Excel bulk-import row ordering.
                var aOcc = that._buildIbpStepOccurrences(s.ibpSteps);
                (s.ibpSteps || []).forEach(function (is, j) {
                    (is.params || []).filter(function (p) { return p.active !== false; }).forEach(function (p) {
                        allParams.push(Object.assign({}, p, { step: is.name, stepOccurrence: aOcc[j] }));
                    });
                });
                allParams = allParams.map(function (p) {
                    if (p.hierarchyId) {
                        var sVal = (p.value || "").trim();
                        if (sVal === "*" || sVal === "") {
                            return Object.assign({}, p, { value: "*" });
                        }
                        var memberIds = sVal.split(",").map(function (s) { return s.trim(); })
                            .filter(function (s) { return s; })
                            .map(function (sOne) { return _expandDateYYYYMM(sOne) || sOne; });
                        return Object.assign({}, p, { value: JSON.stringify({ memberIds: memberIds, hierarchyId: p.hierarchyId }) });
                    }
                    return p;
                });
                // Stash the IBP job template name so it survives reload - there's no DSP
                // baseline to fall back to anymore, so this is the only source of truth
                // and must always be saved whenever a template is set (not just "overrides").
                if (s.ibpTemplateName) {
                    allParams = allParams.concat([{
                        key: "__ibpTemplateNameOverride",
                        value: s.ibpTemplateName,
                        active: true
                    }]);
                }
                // Stash the (possibly user-edited) job name shown in IBP's own job
                // history at launch — same field as the template's auto-fetched
                // description, so this also survives reload even when unedited.
                if (s.ibpTemplateName && s.ibpTemplateDescription) {
                    allParams = allParams.concat([{
                        key: "__ibpJobTextOverride",
                        value: s.ibpTemplateDescription,
                        active: true
                    }]);
                }
                if (s.sacMultiActionId) {
                    allParams = allParams.concat([{
                        key: "__sacMultiActionIdOverride",
                        value: s.sacMultiActionId,
                        active: true
                    }]);
                }
                // Stash the resolved multiaction ID itself unconditionally (not just when
                // there happen to be other params) — the backend needs this sentinel at
                // launch time to inject "multiaction_id" into DSP's payload, which
                // otherwise never carries it (DSP's API step has no notion of SAC).
                if (s.sacMultiActionId) {
                    allParams = allParams.concat([{ key: "__sacMultiActionId", value: s.sacMultiActionId, active: true }]);
                }
                // Persist the "Usa Default" choice (auto-forced when locked, or the
                // user's own choice below the threshold) so /launch's server-side
                // gate and a future reload both see it, not just this session.
                if (s.ibpUseDefaults) {
                    allParams = allParams.concat([{ key: "__ibpUseDefaults", value: "true", active: true }]);
                }
                if (allParams.length) {
                    oOut[s.name] = allParams;
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

            // Hard save-time gate: a step DSP declared as "integration": "ibp"|"sac"
            // (see integrationType in dsp.py) must have the matching Job Template /
            // Multi Action set - mirrors the same mandatory check already enforced on
            // the Excel calendar import. Steps with no declared integrationType are
            // left alone (DSP hasn't tagged them as API tasks yet).
            if (sTargetType === "DSP") {
                var aMissingIntegration = [];
                aSteps.forEach(function (s) {
                    if (s.isSkipStep) return;
                    if (s.integrationType === "ibp" && !s.ibpTemplateName) {
                        aMissingIntegration.push(s.name || s.businessName || "(unnamed step)");
                    } else if (s.integrationType === "sac" && !s.sacMultiActionId) {
                        aMissingIntegration.push(s.name || s.businessName || "(unnamed step)");
                    }
                });
                if (aMissingIntegration.length) {
                    MessageBox.error(
                        "Cannot save: the following API step(s) have no Job Template (IBP) "
                        + "or Multi Action (SAC) associated. Set one before saving:\n\n"
                        + aMissingIntegration.join("\n"),
                        { title: "Missing Job Template / Multi Action" }
                    );
                    return;
                }
            }

            // Hard save-time gate: an IBP template over the param-count threshold
            // must never carry custom parameters, even if the UI lock was somehow
            // bypassed (stale restored state, template switched after params were
            // added, etc.). Reject the whole save rather than silently stripping,
            // so the user sees exactly what needs fixing before they lose work.
            var aBlocking = [];
            aSteps.forEach(function (s) {
                if (!s.ibpParamsLocked) return;
                var aBadParams = (s.ibpSteps || []).some(function (is) {
                    return (is.params || []).some(function (p) { return p.active !== false; });
                });
                if (aBadParams) {
                    aBlocking.push(s.name || s.businessName || "(unnamed step)");
                }
            });
            if (aBlocking.length) {
                MessageBox.error(
                    "Cannot save: the following step(s) use an IBP template that's too large "
                    + "to support custom overrides reliably. Turn on \"Usa Default\" (or "
                    + "remove the custom parameters) before saving:\n\n"
                    + aBlocking.join("\n"),
                    { title: "Too many parameters for custom values" }
                );
                return;
            }

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
        },

    });
});
