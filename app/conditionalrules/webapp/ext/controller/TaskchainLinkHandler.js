sap.ui.define([], function () {
    "use strict";

    return {
        /**
         * Naviga alla Object Page della Taskchain tramite il router di Fiori Elements.
         * Un href diretto ("#/Taskchain(...)") sostituirebbe l'hash della shell di
         * Work Zone (intent non valido -> reload del launchpad); il router invece
         * gestisce l'hash all'interno dell'app, come la navigazione Rule -> dettaglio.
         */
        onTaskchainPress: function (oEvent) {
            var oSource = oEvent.getSource();
            var oContext = oSource.getBindingContext();
            if (!oContext) {
                return;
            }

            var oView = oSource;
            while (oView && !oView.isA("sap.ui.core.mvc.View")) {
                oView = oView.getParent();
            }
            if (!oView) {
                return;
            }

            var sKey = "name='" + oContext.getProperty("taskchain") +
                "',spaceId='" + oContext.getProperty("spaceId") + "'";

            oView.getController().getExtensionAPI().routing
                .navigateToRoute("TaskchainObjectPage", { key: sKey });
        }
    };
});
