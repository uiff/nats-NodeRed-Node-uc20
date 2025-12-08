
**Unofficial Node-RED Package for Weidmüller u-OS Data Hub**

Read, write, and provide variables via NATS protocol using **OAuth2 authentication**.
Optimized for high performance and real-time updates.

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
[{"id":"cdad2fa96dc6eeec","type":"datahub-input","z":"c221537c994b056a","name":"Read Zipcode","connection":"a0ba0e15c8dad779","providerId":"u_os_adm","manualVariables":"digital_nameplate.address_information.zipcode:2","triggerMode":"poll","pollingInterval":"1000","x":190,"y":100,"wires":[["315d179d66bf9b93"]]},{"id":"315d179d66bf9b93","type":"debug","z":"c221537c994b056a","name":"Debug Output","active":true,"tosidebar":true,"console":false,"tostatus":false,"complete":"payload","targetType":"msg","statusVal":"","statusType":"auto","x":440,"y":100,"wires":[]},{"id":"a0ba0e15c8dad779","type":"uos-config","host":"127.0.0.1","port":49360,"clientName":"hub"}]
```

---

## Node Usage

### DataHub - Read
Reads values from existing providers (like `u_os_adm`).
- **Provider ID:** Name of the source provider.
- **Variables:** Use **Load Variables** to browse and select variables.
- **Trigger:** "Event" (instant update) or "Poll" (interval).

### DataHub - Write
Changes values in other providers.
- **Single Mode:** Select a variable from the list. Send `msg.payload` = value.
- **Batch Mode:** Select NO variable (clear selection). Send `msg.payload` as a JSON object: `{"var_key": value, "var2": value}`.
- **Strict Mode:** Automatically handles Fingerprints for strict providers (e.g. `u_os_sbm`).

### DataHub - Provider
Publishes your own data to the Data Hub.
- **Provider ID:** Leave empty to use your Client ID (Recommended).
- **Input:** Send a JSON object: `{ "machine": { "status": "active" } }`.
- **Auto-Discovery:** Automatically creates variable definitions based on your JSON structure.
- **Keep-Alive:** Configurable interval (Default: 300s / 5min) to refresh definitions, preventing timeouts (Provider disappearance) while minimizing traffic.

---

## Troubleshooting

- **Provider not visible?** Ensure **Provider ID** matches your **Client ID**. Easiest way: Leave Provider ID empty in the node.
- **Connection Failed?** Check Host/IP and ensure Client ID/Secret are correct.
- **Variable ID "undefined" or "ERR"?** 
  - Ensure the provider is publishing correct definitions.
  - The nodes attempt to autofix missing IDs by using the variable index (0, 1, 2...) if the provider supports it.
- **Write not working?** Ensure your OAuth client has `hub.variables.readwrite` scope.
- **Debug:** Check the Node-RED "Debug" sidebar for error messages.

---

**License:** MIT  

> **DISCLAIMER:**  
> This is **NOT** an official product of Weidmüller Interface GmbH & Co. KG.  
> This package is maintained by **IoTUeli** as a community contribution.  
> Use at your own risk. No liability or warranty is assumed.
