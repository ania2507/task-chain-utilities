sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"webapp/test/integration/pages/RuleTableList",
	"webapp/test/integration/pages/RuleTableObjectPage"
], function (JourneyRunner, RuleTableList, RuleTableObjectPage) {
    'use strict';

    var runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('webapp') + '/test/flpSandbox.html#webapp-tile',
        pages: {
			onTheRuleTableList: RuleTableList,
			onTheRuleTableObjectPage: RuleTableObjectPage
        },
        async: true
    });

    return runner;
});

