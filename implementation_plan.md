# Implementation Plan - Name Conflict Safety & Restart Stability

## Problem
1.  **"Provider Offline" Loop**: User reports `u_os_sbm` provider dies shortly after restart.
2.  **Root Cause**: User likely configured Node-RED (Connection or Provider Node) to use the Client ID `u_os_sbm`. This causes a **NATS Split Brain**, where Node-RED overwrites the real Device Provider.
3.  **Result**: The real provider disconnects or becomes unstable (503).

## Solution
1.  **Blacklist `u_os_sbm`**:
    -   In `uos-config.js` (Config Node): Check `clientName`. If it is `u_os_sbm` (case-insensitive), force it to `nodered`.
    -   In `datahub-output.js` (Provider Node): Check `providerId`. If it is `u_os_sbm` (case-insensitive), throw a fatal error / refuse to start.

## Proposed Changes

### [uos-config.js](file:///home/iotueli/App/NATS-NodeRED/nodes/uos-config.js)
-   In Constructor:
    ```javascript
    if (this.clientName.toLowerCase() === 'u_os_sbm') {
        this.warn("Illegal Client Name 'u_os_sbm' detected! It conflicts with the system provider. Forcing rename to 'nodered'.");
        this.clientName = 'nodered';
    }
    ```

### [datahub-output.js](file:///home/iotueli/App/NATS-NodeRED/nodes/datahub-output.js)
-   In Constructor:
    ```javascript
    if (this.providerId.toLowerCase() === 'u_os_sbm') {
       this.error("CRITICAL ERROR: You cannot name your Provider 'u_os_sbm'. This ID is reserved for the Device itself! Please change it.");
       this.status({fill:'red', shape:'ring', text:'illegal ID: u_os_sbm'});
       return; // Stop execution
    }
    ```

## Verification
-   User's setup will likely trigger the warning/error immediately.
-   Once they change the ID, the real `u_os_sbm` will stay alive.
