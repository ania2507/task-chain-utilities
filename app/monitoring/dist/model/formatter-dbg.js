sap.ui.define([], function () {
    "use strict";

    /**
     * Formatter functions for the Monitoring application
     * Reusable across all views and controllers
     */
    return {

        /**
         * Format date/time string to readable format
         * @param {string} sDateTime - ISO date string
         * @returns {string} Formatted date/time
         */
        formatDateTime: function (sDateTime) {
            if (!sDateTime) {
                return "";
            }
            try {
                var oDate = new Date(sDateTime);
                if (isNaN(oDate.getTime())) {
                    return sDateTime;
                }
                return oDate.toLocaleString("en-GB", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit"
                });
            } catch (e) {
                return sDateTime;
            }
        },
        
        /**
         * Format status to UI state
         * @param {string} sStatus - The status value
         * @returns {string} The UI state (Success, Error, Warning, None)
         */
        formatStatusState: function (sStatus) {
            if (!sStatus) {
                return "None";
            }
            
            switch (sStatus.toLowerCase()) {
                case "success":
                case "completed":
                case "active":
                    return "Success";
                case "error":
                case "failed":
                    return "Error";
                case "running":
                case "in progress":
                case "in esecuzione":
                    return "Warning";
                default:
                    return "None";
            }
        },

        /**
         * Format status to display text
         * @param {string} sStatus - The status value
         * @returns {string} The display text
         */
        formatStatusText: function (sStatus) {
            if (!sStatus) {
                return "";
            }
            
            var mStatusMap = {
                "success": "Successo",
                "error": "Errore",
                "running": "In Corso",
                "pending": "In Attesa",
                "completed": "Completato",
                "failed": "Fallito"
            };
            
            return mStatusMap[sStatus.toLowerCase()] || sStatus;
        },

        /**
         * Format severity to color/state
         * @param {string} sSeverity - The severity (P1, P2, P3)
         * @returns {string} The UI state
         */
        formatSeverityState: function (sSeverity) {
            switch (sSeverity) {
                case "P1":
                    return "Error";
                case "P2":
                    return "Warning";
                case "P3":
                    return "Information";
                default:
                    return "None";
            }
        },

        /**
         * Format duration in seconds to human readable
         * @param {number} nSeconds - Duration in seconds
         * @returns {string} Formatted duration
         */
        formatDuration: function (nSeconds) {
            if (!nSeconds && nSeconds !== 0) {
                return "-";
            }
            
            if (nSeconds < 60) {
                return nSeconds + " sec";
            } else if (nSeconds < 3600) {
                var nMinutes = Math.floor(nSeconds / 60);
                var nRemainingSeconds = nSeconds % 60;
                return nMinutes + " min " + (nRemainingSeconds > 0 ? nRemainingSeconds + " sec" : "");
            } else {
                var nHours = Math.floor(nSeconds / 3600);
                var nRemainingMinutes = Math.floor((nSeconds % 3600) / 60);
                return nHours + " h " + (nRemainingMinutes > 0 ? nRemainingMinutes + " min" : "");
            }
        },

        /**
         * Format success rate with color coding
         * @param {number} nRate - Success rate percentage
         * @returns {string} UI state
         */
        formatSuccessRateState: function (nRate) {
            if (nRate >= 95) {
                return "Success";
            } else if (nRate >= 80) {
                return "Warning";
            } else {
                return "Error";
            }
        },

        /**
         * Format number with fixed decimal places
         * @param {number} nValue - The number value
         * @param {number} nDecimals - Number of decimal places
         * @returns {string} Formatted number
         */
        formatNumber: function (nValue, nDecimals) {
            if (!nValue && nValue !== 0) {
                return "-";
            }
            return parseFloat(nValue).toFixed(nDecimals || 0);
        },

        /**
         * Format timestamp to locale string
         * @param {string|Date} vTimestamp - The timestamp
         * @returns {string} Formatted date/time
         */
        formatTimestamp: function (vTimestamp) {
            if (!vTimestamp) {
                return "-";
            }
            
            var oDate = vTimestamp instanceof Date ? vTimestamp : new Date(vTimestamp);
            return oDate.toLocaleString("it-IT", {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit"
            });
        },

        /**
         * Format time only from timestamp
         * @param {string|Date} vTimestamp - The timestamp
         * @returns {string} Formatted time
         */
        formatTimeOnly: function (vTimestamp) {
            if (!vTimestamp) {
                return "-";
            }
            
            var oDate = vTimestamp instanceof Date ? vTimestamp : new Date(vTimestamp);
            return oDate.toLocaleTimeString("it-IT", {
                hour: "2-digit",
                minute: "2-digit"
            });
        },

        /**
         * Get icon for status
         * @param {string} sStatus - The status value
         * @returns {string} SAP icon URI
         */
        getStatusIcon: function (sStatus) {
            if (!sStatus) {
                return "sap-icon://status-inactive";
            }
            
            switch (sStatus.toLowerCase()) {
                case "success":
                case "completed":
                    return "sap-icon://accept";
                case "error":
                case "failed":
                    return "sap-icon://error";
                case "running":
                    return "sap-icon://process";
                case "pending":
                    return "sap-icon://pending";
                case "warning":
                    return "sap-icon://warning";
                default:
                    return "sap-icon://status-inactive";
            }
        },

        /**
         * Get DAG node CSS class based on status
         * @param {string} sStatus - The status value
         * @returns {string} CSS class name
         */
        getDagNodeClass: function (sStatus) {
            if (!sStatus) {
                return "dagNodePending";
            }
            
            switch (sStatus.toLowerCase()) {
                case "success":
                    return "dagNodeSuccess";
                case "error":
                    return "dagNodeError";
                case "running":
                    return "dagNodeRunning";
                case "warning":
                    return "dagNodeWarning";
                default:
                    return "dagNodePending";
            }
        },

        /**
         * Get project health status icon based on success rate
         * @param {number} nSuccessRate - Success rate percentage
         * @returns {string} SAP icon URI
         */
        getProjectStatusIcon: function (nSuccessRate) {
            if (nSuccessRate === undefined || nSuccessRate === null) {
                return "sap-icon://status-inactive";
            }
            if (nSuccessRate >= 95) {
                return "sap-icon://status-positive";
            } else if (nSuccessRate >= 80) {
                return "sap-icon://status-critical";
            } else {
                return "sap-icon://status-negative";
            }
        },

        /**
         * Get project health status color based on success rate
         * @param {number} nSuccessRate - Success rate percentage
         * @returns {string} Semantic color
         */
        getProjectStatusColor: function (nSuccessRate) {
            if (nSuccessRate === undefined || nSuccessRate === null) {
                return "Neutral";
            }
            if (nSuccessRate >= 95) {
                return "Positive";
            } else if (nSuccessRate >= 80) {
                return "Critical";
            } else {
                return "Negative";
            }
        },

        /**
         * Get ProgressIndicator state based on success rate
         * @param {number} nSuccessRate - Success rate percentage
         * @returns {string} ValueState
         */
        getProgressState: function (nSuccessRate) {
            if (nSuccessRate === undefined || nSuccessRate === null) {
                return "None";
            }
            if (nSuccessRate >= 95) {
                return "Success";
            } else if (nSuccessRate >= 80) {
                return "Warning";
            } else {
                return "Error";
            }
        },

        /**
         * Format success rate as display text
         * @param {number} nSuccessRate - Success rate percentage
         * @returns {string} Formatted percentage
         */
        formatSuccessRateText: function (nSuccessRate) {
            if (nSuccessRate === undefined || nSuccessRate === null) {
                return "N/A";
            }
            return Math.round(nSuccessRate) + "%";
        },

        /**
         * Get error count state (highlight high errors)
         * @param {number} nErrors - Error count
         * @returns {string} ValueState
         */
        getErrorCountState: function (nErrors) {
            if (!nErrors || nErrors === 0) {
                return "Success";
            } else if (nErrors < 5) {
                return "Warning";
            } else {
                return "Error";
            }
        }
    };
});
