# node-red-contrib-uos-nats

**Unofficial Node-RED Package for u-OS Data Hub**

Built and maintained by [IoTUeli](https://www.linkedin.com/in/iotueli/). This is **not** an official Weidmüller product.  
Repository: <https://github.com/uiff/nats-NodeRed-Node-uc20>

---

## What is this?

Node-RED nodes to **read** and **write** variables from the **u-OS Data Hub** via NATS protocol.

### The Three Nodes:

1. **u-OS Config** – Connection settings (Host, OAuth credentials, NATS connection)
2. **DataHub - IN** – Read variables from Data Hub providers
3. **DataHub - OUT** – Write variables to the Data Hub (creates your own provider)

---

## Installation

### From npm (Recommended)
```bash
cd ~/.node-red
npm install node-red-contrib-uos-nats
```

### From Local Folder (Development)
```bash
npm install /path/to/NATS-NodeRED
```

Restart Node-RED. The nodes appear in the **"u-OS DataHub NATS"** category in the palette.

---

## 1. u-OS Config Node

### Purpose
Stores connection details and OAuth credentials. All DataHub nodes share this configuration.

### Setup Steps

1. **Add a Config Node:**
   - Open any DataHub node (IN or OUT)
   - Click the pencil icon next to "Config"
   - Click "Add new uos-config..."

2. **Fill in the Fields:**

| Field | Example | Description |
|-------|---------|-------------|
| **Host** | `192.168.10.100` | IP address of your u-Control device |
| **Port** | `49360` | NATS port (default: 49360) |
| **Client Name** | `nodered` | Unique name for this Node-RED instance |
| **Client ID** | `my-oauth-client` | OAuth2 Client ID (from Control Center) |
| **Client Secret** | `****************` | OAuth2 Client Secret (from Control Center) |
| **Scopes** | `hub.variables.*` | Leave default or customize (see below) |

3. **Create OAuth Client in Control Center:**
   - Open the u-Control Web Interface
   - Go to **System** → **Access Control** → **OAuth Clients**
   - Click **"Add Client"**
   - **Name:** `nodered`
   - **Scopes:** Select all `hub.variables.*` (provide, readonly, readwrite)
   - **Copy the Client ID and Secret** into Node-RED

4. **Test Connection:**
   - Click **"Test Connection"** button
   - ✅ Success: Shows "Connected" + granted scopes
   - ❌ Error: Check Host/Port/Credentials

---

## 2. DataHub - IN Node (Read Variables)

### Purpose
Subscribe to variables from a Data Hub provider and output their values as JSON messages.

### Setup Steps

#### Step 1: Select Config
- Choose your **u-OS Config** node

#### Step 2: Enter Provider ID
- **What is it?** The name of the data source (e.g., `u_os_sbm`, `hub`, `custom-provider`)
- **Where to find it?**
  - u-Control Web Interface → **Data Hub** → **Providers**
  - Or use the Python sample's `PROVIDER_ID`

**Example:** `u_os_sbm`

#### Step 3: Add Variables (Manual Table)
Since auto-discovery often fails due to permissions, you **manually map** variable names to their IDs.

**How to find Variable IDs:**

**Option A: From Python Config**
```python
# Your working Python config.py
VARIABLE_DEFINITIONS = [
    {"id": 0, "key": "manufacturer_name", ...},
    {"id": 2, "key": "machine.details.temp", ...}
]
```
→ Use these IDs!

**Option B: From u-Control Web UI**
1. Open **Data Hub** → **Providers** → Select your provider
2. Click on **Variables**
3. Note the **ID** column (usually 0, 1, 2, ...)

**Option C: From REST API**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://192.168.10.100/datahub/v1/providers/u_os_sbm/variables
```

**Fill the Table:**

| Variable Name | ID |
|--------------|-----|
| `manufacturer_name` | `0` |
| `machine.details.temp` | `2` |

Click **"Add Variable"** for each entry.

#### Step 4: Choose Trigger Mode

| Mode | When to Use |
|------|-------------|
| **Event (on change)** | Default. Efficient. Outputs only when values change. |
| **Poll (interval)** | Forces periodic reads (e.g., every 1000ms). Less efficient. |

#### Step 5: Deploy & Test
1. Click **Deploy**
2. Connect a **Debug** node to the output
3. Send a message to the **Input Port** (using an **Inject** node) to trigger a read
4. Check the Debug panel for output:
   ```json
   {
     "type": "snapshot",
     "variables": [
       {"providerId": "u_os_sbm", "id": 0, "key": "manufacturer_name", "value": "Weidmüller", ...}
     ]
   }
   ```

### Troubleshooting

| Problem | Solution |
|---------|----------|
| No output | Check: (1) Config deployed? (2) Provider ID correct? (3) Variable IDs correct? (4) Inject signal sent? |
| "Variable not found" | Double-check IDs in the table. Use Python config or Web UI to verify. |
| Permission errors | This is expected! That's why we use the manual table. |

---

## 3. DataHub - OUT Node (Write Variables)

### Purpose
**Creates a real Data Hub provider** that publishes variables to the u-OS Data Hub. Other applications, devices, or even other Node-RED instances can **subscribe to your data in real-time**.

### How It Works

The OUT node:
1. **Registers as a Provider** on the Data Hub (e.g., provider ID: `nodered`)
2. **Publishes variable definitions** automatically when new variables are sent
3. **Sends value updates** via NATS when you send JSON messages
4. **Answers read requests** from other consumers (apps can query your latest values)
5. **Supports event-driven subscriptions** - other apps get updates **instantly** when values change

**Important:** This provider only exists **while Node-RED is running**. When you restart Node-RED, the provider re-registers automatically.

### Real-World Use Cases

✅ **IoT Data Collection:** Node-RED reads sensor data (Modbus, MQTT, etc.) and publishes it to the Data Hub  
✅ **Edge Processing:** Process data locally in Node-RED, then share results with other apps  
✅ **System Integration:** Bridge between different protocols (e.g., OPC UA → Data Hub)  
✅ **Custom Dashboards:** Other apps can subscribe to Node-RED's variables for visualization  

### Setup Steps

#### Step 1: Select Config
- Choose your **u-OS Config** node

#### Step 2: Provider ID (Optional)
- **Leave EMPTY** to use the `Client Name` from your Config (recommended)
- Or enter a custom provider ID (e.g., `my-machine-data`)

**Example:** If your Config's Client Name is `nodered`, the provider will be `nodered`

#### Step 3: Send JSON Messages
Send a JSON object with your data:

```json
{
  "temperature": 25.5,
  "machine": {
    "status": "running",
    "speed": 1500
  }
}
```

This creates variables:
- `temperature` → ID 0
- `machine.status` → ID 1
- `machine.speed` → ID 2

**The variables are INSTANTLY available to other apps via:**
- **Event subscriptions** (other apps get updates when values change)
- **Read queries** (other apps can request current values)
- **u-Control Web UI** (visible in Data Hub → Providers → `nodered`)

### Event-Driven Communication

When you send a message to the OUT node:

```
[Function: {"temp": 22.5}] → [DataHub - OUT] 
                                    ↓
                    ┌───────────────────────────────┐
                    │   u-OS Data Hub (NATS)        │
                    └───────────────────────────────┘
                     ↓           ↓            ↓
              [Python App]  [Dashboard]  [Other Node-RED]
              (subscribes)  (subscribes)  (subscribes)
```

**All subscribers receive the update IMMEDIATELY** - no polling needed!

#### Step 4: Deploy & Test
1. Connect a **Function** or **Inject** node
2. Click **Deploy**
3. Check the u-Control Web Interface → **Data Hub** → Your Provider

---

## Example Flow

```
[Inject] → [DataHub - IN] → [Debug]
           (u_os_sbm)

[Inject: {"temp": 22}] → [DataHub - OUT]
                         (nodered)
```

**Copy this flow:**
```json
[{"id":"inject1","type":"inject","name":"Trigger Read"},
 {"id":"datahub-in","type":"datahub-input","connection":"config1","providerId":"u_os_sbm","manualVariables":"manufacturer_name:0"},
 {"id":"debug1","type":"debug"}]
```

---

## FAQ

### Q: Why manual IDs? Can't it auto-discover?
**A:** Auto-discovery requires `hub.variables.readonly` permission on the **provider definition** endpoint, which is often restricted. The manual table works **without** this permission because it queries specific IDs directly.

### Q: Where do I get Client ID/Secret?
**A:** u-Control Web Interface → **System** → **Access Control** → **OAuth Clients** → **Add Client**

### Q: What are the required OAuth scopes?
**A:** 
- **Read (IN Node):** `hub.variables.readonly`
- **Write (OUT Node):** `hub.variables.provide` + `hub.variables.readwrite`
- **Recommended:** Select all `hub.variables.*` scopes when creating the client

### Q: Can I use this outside the local network?
**A:** Yes, if your u-Control device is reachable over the network and you configure the correct Host/Port.

### Q: Event vs Poll - which is better?
**A:** **Event** (default) is more efficient. Use **Poll** only if you need guaranteed periodic readings regardless of value changes.

---

## Changelog

See [GitHub Releases](https://github.com/uiff/nats-NodeRed-Node-uc20/releases)

---

## Support

**Issues, Questions, or Feature Requests:**  
Contact [IoTUeli](https://www.linkedin.com/in/iotueli/) or open an issue on [GitHub](https://github.com/uiff/nats-NodeRed-Node-uc20)

---

## License

MIT License

**Disclaimer:** This package is a community contribution, not an official Weidmüller product.
