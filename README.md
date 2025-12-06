# node-red-contrib-uos-nats

**Unofficial Node-RED Package for u-OS Data Hub**

Built and maintained by [IoTUeli](https://iotueli.ch). This is **not** an official Weidmüller product.  
Repository: <https://github.com/uiff/nats-NodeRed-Node-uc20>

---

## What is this?

Node-RED nodes to **read** and **write** variables from the **Weidmüller u-OS Data Hub** via NATS protocol.

### The Three Nodes

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

## Why NATS Instead of REST API?

The u-OS Data Hub offers both **NATS** (this package) and **REST API** access. Here's why NATS is the better choice for Node-RED:

### Feature Comparison

| Feature | NATS Protocol | REST API |
|---------|---------------|----------|
| **Real-time Updates** | ✅ Event-driven (instant) | ❌ Polling required (delays) |
| **Performance** | ✅ Binary protocol, high-throughput | ❌ HTTP/JSON overhead |
| **Communication** | ✅ Bidirectional (Pub/Sub + Request/Reply) | ❌ Client-initiated only |
| **Provider Registration** | ✅ Dynamic discovery & auto-registration | ❌ Static endpoints |
| **Scalability** | ✅ Many-to-many connections | ❌ Point-to-point requests |
| **Network Efficiency** | ✅ Push notifications (no polling waste) | ❌ Repeated GET requests |

### Event-Driven Architecture

**NATS enables true event-driven workflows:**

```
Sensor changes value
       ↓
Data Hub publishes event via NATS
       ↓
Node-RED receives update INSTANTLY (0ms delay)
       ↓
Process & forward to other systems
```

**With REST API you'd need:**
- Constant polling (e.g., every 100ms)
- Increased network traffic
- Delayed reactions
- Higher CPU usage

### Use NATS when

✅ You need **real-time reactions** to value changes  
✅ You want to **create providers** (publish data to Data Hub)  
✅ You need **event subscriptions** (get notified on changes)  
✅ You're building **scalable industrial workflows**  

### Use REST API when

⚠️ You only need **occasional manual reads**  
⚠️ You're debugging or doing one-time queries  
⚠️ NATS port (49360) is blocked in your network  

---

## Quick Start Guide

### Step 1: Create OAuth Client in u-OS

Before configuring Node-RED, create an OAuth client on your u-OS device:

1. Open the **u-OS Web Interface** (e.g., `http://192.168.10.100`)
2. Go to **System** → **Access Control** → **OAuth Clients**
3. Click **"Add Client"**
4. Enter:
   - **Name:** `nodered`
   - **Scopes:** Select **all** `hub.variables.*` scopes:
     - `hub.variables.provide` (for creating providers)
     - `hub.variables.readonly` (for reading)
     - `hub.variables.readwrite` (for writing)
5. **Save** and copy the **Client ID** and **Client Secret**

### Step 2: Configure u-OS Config Node in Node-RED

1. Drag any **DataHub - IN** or **DataHub - OUT** node onto the canvas
2. Double-click it to open settings
3. Click the **pencil icon** next to "Config"
4. Select **"Add new uos-config..."**
5. Fill in:

| Field | Example | Description |
|-------|---------|-------------|
| **Host** | `192.168.10.100` | IP of your u-OS device |
| **Port** | `49360` | NATS port (default) |
| **Client Name** | `nodered` | Unique name for this instance |
| **Client ID** | `my-oauth-client` | From Step 1 |
| **Client Secret** | `****************` | From Step 1 |

6. Click **"Test Connection"** to verify
7. On success, click **"Add"** then **"Done"**

### Step 3: Deploy Your First Flow

Import this example flow to test both reading and writing:

```json
[{"id":"cdad2fa96dc6eeec","type":"datahub-input","z":"c221537c994b056a","name":"","connection":"a0ba0e15c8dad779","providerId":"u_os_adm","manualVariables":"digital_nameplate.address_information.zipcode:2","triggerMode":"poll","pollingInterval":"100","x":110,"y":40,"wires":[["315d179d66bf9b93"]]},{"id":"315d179d66bf9b93","type":"debug","z":"c221537c994b056a","name":"debug 7","active":false,"tosidebar":true,"console":false,"tostatus":false,"complete":"false","statusVal":"","statusType":"auto","x":740,"y":40,"wires":[]},{"id":"09f29f6bfc4e1be2","type":"inject","z":"c221537c994b056a","name":"","props":[{"p":"payload"},{"p":"topic","vt":"str"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","payload":"","payloadType":"date","x":120,"y":140,"wires":[["43b2fcf73c370f7c"]]},{"id":"43b2fcf73c370f7c","type":"function","z":"c221537c994b056a","name":"Random Data","func":"function randomBetween(min, max) {\n    return Math.random() * (max - min) + min;\n}\n\nmsg.payload = {\n    machine: {\n        status: \"running\",\n        details: {\n            temp: randomBetween(30, 80)\n        }\n    }\n};\n\nreturn msg;","outputs":1,"timeout":0,"noerr":0,"initialize":"","finalize":"","libs":[],"x":300,"y":140,"wires":[["a90304487fe19b3a"]]},{"id":"a90304487fe19b3a","type":"datahub-output","z":"c221537c994b056a","name":"","connection":"a0ba0e15c8dad779","providerId":"","x":500,"y":140,"wires":[["e53fa58e4c1987ba"]]},{"id":"e53fa58e4c1987ba","type":"debug","z":"c221537c994b056a","name":"debug 6","active":false,"tosidebar":true,"console":false,"tostatus":false,"complete":"payload","targetType":"msg","statusVal":"","statusType":"auto","x":740,"y":140,"wires":[]},{"id":"a0ba0e15c8dad779","type":"uos-config","host":"127.0.0.1","port":49360,"clientName":"hub","scope":"hub.variables.provide hub.variables.readwrite hub.variables.readonly"}]
```

**What this flow does:**

**Top Row** (Reading):
- **DataHub - IN** reads `zipcode` variable from provider `u_os_adm`
- Polls every 100ms
- Outputs to Debug node

**Bottom Row** (Writing):
- **Inject** node triggers data generation
- **Function** node creates random temperature data
- **DataHub - OUT** publishes to Data Hub as provider `hub`
- Creates variables: `machine.status` and `machine.details.temp`

**To customize:**
1. Edit the **DataHub - IN** node:
   - Change `Provider ID` to match your system
   - Update variable mappings in the table
2. Edit the **Function** node to generate your data structure
3. Click **Deploy**

---

## Finding Variable IDs

The **DataHub - IN** node requires variable IDs (numbers). Here's how to find them:

### Option 1: u-OS Web Interface

1. Open **Data Hub** → **Providers**
2. Click on your target provider (e.g., `u_os_adm`)
3. Click **Variables** tab
4. Note the **ID** column (e.g., `0`, `1`, `2`)

### Option 2: REST API Query

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://192.168.10.100/datahub/v1/providers/u_os_adm/variables
```

Response shows variable definitions with IDs:
```json
{
  "variables": [
    {"id": 0, "key": "manufacturer_name", ...},
    {"id": 2, "key": "digital_nameplate.address_information.zipcode", ...}
  ]
}
```

### Option 3: Check Other Apps

If you have other Data Hub clients (apps, PLCs), check their variable definitions to find the IDs.

---

## DataHub - IN Node (Read Variables)

### Purpose
Subscribe to variables from a Data Hub provider and output their values as JSON messages.

### Configuration

1. **Config Node:** Select your u-OS connection
2. **Provider ID:** Enter the provider name (e.g., `u_os_adm`, `hub`, `u_os_sbm`)
3. **Variables Table:** Manually map variable names to IDs

| Variable Name | ID |
|--------------|-----|
| `manufacturer_name` | `0` |
| `zipcode` | `2` |

Click **"Add Variable"** for each entry.

4. **Trigger Mode:**
   - **Event (on change):** Efficient. Outputs only when values change.
   - **Poll (interval):** Forces periodic reads (e.g., every 100ms).

### Output Format

```json
{
  "type": "snapshot",
  "variables": [
    {
      "providerId": "u_os_adm",
      "id": 2,
      "key": "zipcode",
      "value": "12345",
      "quality": "GOOD",
      "timestampNs": 1234567890000000000
    }
  ]
}
```

### Triggering Reads

Connect an **Inject** node to the input port to trigger manual reads.

---

## DataHub - OUT Node (Write Variables)

### Purpose
Creates a real Data Hub provider that publishes variables. Other applications can subscribe to your data in real-time.

### How It Works

The OUT node:
1. **Registers as a Provider** on the Data Hub (uses `Client Name` from Config)
2. **Publishes variable definitions** automatically when new variables are sent
3. **Sends value updates** via NATS when you send JSON messages
4. **Answers read requests** from other consumers
5. **Supports event-driven subscriptions** - other apps get updates **instantly**

### Configuration

1. **Config Node:** Select your u-OS connection
2. **Provider ID:** Leave **empty** to use `Client Name` (recommended)

### Send Data

Send JSON to the input:

```json
{
  "temperature": 25.5,
  "machine": {
    "status": "running",
    "speed": 1500
  }
}
```

This creates:
- `temperature` → Variable ID 0
- `machine.status` → Variable ID 1
- `machine.speed` → Variable ID 2

**Other apps can now:**
- Subscribe to value changes (event-driven, instant updates)
- Query current values (on-demand reads)
- View in u-OS Web UI (**Data Hub** → **Providers** → `nodered`)

### Event-Driven Communication

```
[Node-RED: DataHub - OUT] → [u-OS Data Hub (NATS)]
                                      ↓
                        ┌─────────────┼─────────────┐
                        ↓             ↓             ↓
                  [Other Apps]  [Dashboards]  [PLCs]
                  (subscribe)   (subscribe)   (subscribe)
```

**All subscribers receive updates IMMEDIATELY** - no polling needed!

---

## Troubleshooting

### No Output from IN Node

✓ Config node deployed?  
✓ Provider ID correct? (check u-OS Web UI → Data Hub → Providers)  
✓ Variable IDs correct? (check u-OS Web UI → Variables)  
✓ Inject signal sent to input port?  

### "Variable not found" Error

- Double-check IDs in the Variables table
- Verify IDs match those in u-OS Web UI

### Connection Test Fails

- Check Host/Port are correct and device is reachable
- Verify Client ID/Secret match exactly
- Ensure OAuth client exists in u-OS
- Verify all `hub.variables.*` scopes are granted

### Why Manual IDs?

Auto-discovery requires special permissions on the provider definition endpoint, which are often restricted for security. The manual table works **without** this permission by querying specific IDs directly.

---

## FAQ

### Q: Can I use the provider created by OUT node in the IN node?
**A:** **No, don't do this!** The OUT provider only exists while Node-RED runs. On restart, it disappears and the IN node fails. Read from **system providers** (`u_os_sbm`, `u_os_adm`) or other persistent apps instead.

### Q: Where do I get Client ID/Secret?
**A:** u-OS Web Interface → **System** → **Access Control** → **OAuth Clients** → **Add Client**

### Q: What are the required OAuth scopes?
**A:** 
- **Read (IN Node):** `hub.variables.readonly`
- **Write (OUT Node):** `hub.variables.provide` + `hub.variables.readwrite`
- **Recommended:** Select all `hub.variables.*` scopes when creating the client

### Q: Can I use this outside the local network?
**A:** Yes, if your u-OS device is reachable over the network and you configure the correct Host/Port.

### Q: Event vs Poll - which is better?
**A:** **Event** (default) is more efficient. Use **Poll** only if you need guaranteed periodic readings regardless of value changes.

---

## Support

**Issues, Questions, or Feature Requests:**  
Contact [IoTUeli](https://iotueli.ch) or open an issue on [GitHub](https://github.com/uiff/nats-NodeRed-Node-uc20)

---

## License

MIT License

**Disclaimer:** This package is a community contribution, not an official Weidmüller product.
