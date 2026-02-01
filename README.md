**Unofficial Node-RED Package for Weidmüller u-OS Data Hub**

Read, write, and provide variables via NATS protocol using **OAuth2 authentication**.
Optimized for high performance and real-time updates.

> **IMPORTANT:**
> These nodes **MUST** run directly on the **u-OS device** (e.g. as a simplified App or Snap).
> The system's NATS server is **NOT accessible from the outside** (blocked by firewall/binding).
> You cannot use this package from a remote Node-RED instance (e.g. on your Laptop) to connect to the device.

Maintained by [IoTUeli](https://iotueli.ch). Source: [GitHub](https://github.com/uiff/nats-NodeRed-Node-uc20)

---

## Nodes Overview

| Node | Purpose |
|------|---------|
| **u-OS Config** | Central configuration for NATS connection and OAuth credentials. |
| **DataHub - Read** | Subscribe to variable changes from system providers (e.g. `u_os_adm`). |
| **DataHub - Write** | Send commands to change variables in other providers. |
| **DataHub - Provider** | Create your own provider to publish variables to the Data Hub. |

---

## Installation

Run the following command in your Node-RED user directory (usually `~/.node-red`):

```bash
npm install node-red-contrib-uos-nats
```

Restart Node-RED. The nodes will appear in the **"Weidmüller DataHub"** category.

---

## Quick Start

### 1. Create OAuth Client (in u-OS)

1. Open **u-OS Web UI** (Control Center → Identity & access → Clients).
2. Click **Add client**.
3. Name: `nodered` (example).
4. Scopes: Select **all** `hub.variables.*` scopes.
5. Copy **Client ID** and **Client Secret**.

### 2. Configure Node-RED

1. Drag a **DataHub - Read** node to the canvas.
2. Click the pencil ✏️ next to **Connection**.
3. Enter:
   - **Host:** IP of your u-OS device (e.g. `192.168.10.100`)
   - **Client Name:** Important! Give it a name (e.g. `nodered`).
   - **Client ID / Secret:** Paste from Step 1.
4. Click **Test connection**.

### 3. Example Flow

Import this flow to test reading and writing immediately:

```json
[{"id":"cdad2fa96dc6eeec","type":"datahub-input","z":"c221537c994b056a","name":"Read Zipcode","connection":"a0ba0e15c8dad779","providerId":"u_os_adm","manualVariables":"digital_nameplate.address_information.zipcode:2","triggerMode":"event","pollingInterval":"1000","x":190,"y":100,"wires":[["315d179d66bf9b93"]]},{"id":"315d179d66bf9b93","type":"debug","z":"c221537c994b056a","name":"Debug Output","active":true,"tosidebar":true,"console":false,"tostatus":false,"complete":"payload","targetType":"msg","statusVal":"","statusType":"auto","x":440,"y":100,"wires":[]},{"id":"a0ba0e15c8dad779","type":"uos-config","clientName":"nodered-client"}]
```

---

## Node Usage

### DataHub - Read
Reads values from existing providers (like `u_os_adm`).
- **Provider ID:** Name of the source provider.
- **Variables:** Use **Load Variables** to browse and select variables.
- **Trigger:** "Event" (instant update) or "Poll" (interval).
- **Dynamic Read:** Send `msg.payload` as an Array of keys (e.g. `["machine.status", "temp"]`) to trigger a specific snapshot, ignoring the node configuration.

### DataHub - Write
Changes values in other providers.
-   **Single Mode:** Select a variable from the list. Send `msg.payload` = value.
-   **Batch Mode:** Select NO variable (clear selection). Send `msg.payload` as a FLAT JSON object: `{"var_key": value, "machine.status": value}` (uses Configured Provider). **Nested objects are NOT supported** (keys must use dot-notation).
-   **Dynamic Mode:** Send a full target object to write anywhere:
    ```json
    {
      "provider": "target_provider_id",
      "key": "variable_key",
      "value": 123
    }
    ```json
    {
      "provider": "u_os_sbm",
      "key": "ur20_8do_p_1.process_data.channel_7.do",
      "value": 123
    }
    ```
    Or send an **Array** of these objects to write to multiple providers in one go.
-   **Strict Mode:** Automatically handles Fingerprints for strict providers (e.g. `u_os_sbm`).

### DataHub - Provider
Publishes your own data to the Data Hub.
- **Provider ID:** Leave empty to use your Client ID (Recommended).
- **Input:** Send a JSON object: `{ "machine": { "status": "active" } }`.
- **Auto-Discovery:** Automatically creates variable definitions based on your JSON structure.
- **Bi-Directional:** Enable "Allow external writes" to let other apps write to your variables. Changes are emitted continuously on the **2nd Output**.
- **Keep-Alive:** Configurable interval (Default: 300s / 5min).
- **Quality & Timestamp:** Override metadata by sending an object:
  ```json
  { "temp": { "value": 23.5, "quality": "BAD", "timestamp": 1712000000 } }
  ```

---

### 3. u-OS API Node (Orange)
The **u-OS API** node provides a unified HTTP interface for both DataHub Variables and System Administration.

*   **Mode: DataHub Variables**
    *   Alternative access to variables via HTTP (REST) instead of NATS.
    *   Actions: `Read`, `Write`, `List Providers`, `List Variables`.
    *   Useful for one-off requests or environments where NATS is restricted.

*   **Mode: System Administration**
    *   Manage the u-OS device itself.
    *   **Categories**:
        *   **System**: Get info, nameplate, disk usage, or trigger reboot.
        *   **Network**: Read/Write network IP/Gateway/DNS configuration.
        *   **Security**: Enable/Disable Root access.
        *   **Logging**: Access system logs and trigger reports.
        *   **Recovery**: Factory Reset.
    *   **Requirements**: You must enable **System Admin Access** in the `u-OS Config` node to grant the necessary OAuth scopes (`u-os-adm.*`).

## Configuration
1.  **Host**: IP address of the u-OS device (default: `127.0.0.1` for local Node-RED).
2.  **Auth**: Client ID and Client Secret (from u-OS Device Administration).
3.  **Scopes**:
    *   Standard scopes for DataHub are active by default.
    *   Check **"Enable System Admin Access"** to manage the system.

---

## Performance & Reliability
- **High-Speed Decoding (Filter-on-Decode):** The node now intelligently filters incoming data at the byte-level. Even if a provider sends thousands of variables, Node-RED only decodes the ones you have selected. This massively reduces CPU usage.
- **Large Buffers:** The internal NATS buffer has been increased (10MB) to handle event bursts (e.g. rapid switching).
- **Slow Consumer Warning:** If Node-RED cannot keep up, a "SLOW CONSUMER" warning will appear in the debug log to alert you of dropped messages.

## UI Features
- **Grouped Variables:** Variables are automatically grouped by folder (prefix) in the selection list (e.g. `ur20._4com...`).
- **Smart Filtering:** 
    - **Read Node** shows all variables.
    - **Write Node** automatically hides Read-Only variables to prevent errors.

## Troubleshooting

- **Provider not visible?** Ensure **Provider ID** matches your **Client ID**. Easiest way: Leave Provider ID empty in the node.
- **Node Status is Green (Ring)?**
  - `waiting for provider`: The node is connected to NATS (OK), but the target Provider (e.g. `u_os_sbm`) is currently offline. It will resume automatically.
- **Node Status is Yellow?**
  - `cooldown (10s)`: The node is pausing after an error to protect the network.
  - `auth failed`: OAuth credentials generated an error. Check Client Secret.
- **Node Status is Red?**
  - `illegal ID`: You used a reserved name like `u_os_sbm`. Rename your Client/Provider.
  - `write error`: A command failed. Check Scopes (`hub.variables.readwrite`) or Fingerprint.
- **Variable ID "undefined" or "ERR"?** 
  - The ID column is hidden by default to avoid confusion. The node handles ID resolution automatically.
  - If a variable fails, check if the Key (name) is correct on the Data Hub.
- **Write not working?** Ensure your OAuth client has `hub.variables.readwrite` scope.
- **Debug:** Check the Node-RED "Debug" sidebar for error messages.

---

**License:** MIT  

> **DISCLAIMER:**  
> This is **NOT** an official product of Weidmüller Interface GmbH & Co. KG.  
> This package is maintained by **IoTUeli** as a community contribution.  
> Use at your own risk. No liability or warranty is assumed.
