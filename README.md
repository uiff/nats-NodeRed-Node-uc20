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
| **Read** | Subscribe to variable changes from system providers (e.g. `u_os_adm`). |
| **Write** | Send commands to change variables in other providers. |
| **Provider** | Create your own provider to publish variables to the Data Hub. |
| **u-OS** | Unified HTTP Interface for Variables & System Admin (Reboot, Networking, etc.). |

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

1. Drag a **Read** node to the canvas.
2. Click the pencil ✏️ next to **Connection**.
3. Enter:
   - **Host:** IP of your u-OS device (e.g. `127.0.0.1` for local).
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

### Read (DataHub Input)
Reads values from existing providers (like `u_os_adm`).
- **Provider ID:** Name of the source provider.
- **Variables:** Use **Load Variables** to browse and select variables.
  - **New:** Supports **Multi-Select** and **Categorization** (Grouped by prefix).
- **Trigger:** "Event" (instant update) or "Poll" (interval).
- **Chunking (New):** Automatically splits large requests (>100 variables) to prevent timeouts.

### Write (DataHub Write)
Changes values in other providers.
-   **Single Mode:** Select a variable from the list. Send `msg.payload` = value.
-   **Batch Mode:** Select NO variable (clear selection). Send `msg.payload` as a FLAT JSON object: `{"var_key": value}`.
-   **Strict Mode:** Automatically handles Fingerprints for strict providers (e.g. `u_os_sbm`).

### Provider (DataHub Output)
Publishes your own data to the Data Hub.
- **Provider ID:** Name of your provider (e.g. `my-app`).
- **Auto-Discovery:** Automatically creates variable definitions based on your input JSON structure.
- **Bi-Directional:** Enable "Allow external writes" to receive commands from other apps.

---

### u-OS (API Node)
The **u-OS** node provides a unified HTTP interface for both DataHub Variables and System Administration.

*   **Mode: DataHub Variables**
    *   Alternative access to variables via HTTP (REST) instead of NATS.
    *   Actions: `Read`, `Write`, `List Providers`, `List Variables`.
    *   Useful for one-off requests or environments where NATS is restricted.
    *   **New:** Variable Multi-Select and Grouping now supported.

*   **Mode: System Administration**
    *   Manage the u-OS device itself.
    *   **Categories**: System (Reboot), Network, Security, Logging.
    *   **Requirements**: You must enable **System Admin Access** in the `u-OS Config` node.

## Configuration
1.  **Host**: IP address of the u-OS device (default: `127.0.0.1` for local Node-RED).
2.  **Auth**: Client ID and Client Secret (from u-OS Device Administration).
3.  **Scopes**:
    *   Standard scopes for DataHub are active by default.
    *   Check **"Enable System Admin Access"** to manage the system.

---

## Performance & Optimization
- **HTTPS Agent:** Secure connection handling (no global TLS override).
- **Chunking:** Large variable lists are split into 100-item chunks for reliable reading.
- **Filter-on-Decode:** High-speed filtering at the byte-level to save CPU.

### ⏱️ Benchmarking
You can verify the speed of your u-OS / NATS setup using the included benchmark flow.
1. Import `examples/benchmark-flow.json`.
2. Configure your credentials.
3. Click the inject button.
4. Check the Debug output for "Latency Result".

**Expected Round-Trip-Time (RTT):**
*   **< 4ms:** Excellent (Localhost / standard)
*   **< 10ms:** OK (High Load)
*   **> 20ms:** System overloaded or Slow Consumer bottleneck.

## Troubleshooting

- **Provider not visible?** Check Client ID and Scopes.
- **Status "cooldown"?** The node is pausing after an error to protect the network.
- **Status "illegal ID"?** You used a reserved name. Use `nodered` or similar.
- **Write not working?** Ensure your OAuth client has `hub.variables.readwrite` scope.
- **Debug:** Check the Node-RED "Debug" sidebar for error messages.

---

**License:** MIT  

> **DISCLAIMER:**  
> This is **NOT** an official product of Weidmüller Interface GmbH & Co. KG.  
> This package is maintained by **IoTUeli** as a community contribution.  
> Use at your own risk. No liability or warranty is assumed.
