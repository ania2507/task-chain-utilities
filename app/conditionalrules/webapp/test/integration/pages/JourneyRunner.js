sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"conditionalrules/test/integration/pages/RuleTableList",
	"conditionalrules/test/integration/pages/RuleTableObjectPage"
], function (JourneyRunner, RuleTableList, RuleTableObjectPage) {
    'use strict';

    var runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('conditionalrules') + '/test/flpSandbox.html#conditionalrules-tile',
        pages: {
			onTheRuleTableList: RuleTableList,
			onTheRuleTableObjectPage: RuleTableObjectPage
        },
        async: true
    });

    return runner;
});

