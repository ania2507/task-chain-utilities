sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"skipoverrides/test/integration/pages/SkipOverrideList",
	"skipoverrides/test/integration/pages/SkipOverrideObjectPage"
], function (JourneyRunner, SkipOverrideList, SkipOverrideObjectPage) {
    'use strict';

    var runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('skipoverrides') + '/test/flpSandbox.html#skipoverrides-tile',
        pages: {
			onTheSkipOverrideList: SkipOverrideList,
			onTheSkipOverrideObjectPage: SkipOverrideObjectPage
        },
        async: true
    });

    return runner;
});

