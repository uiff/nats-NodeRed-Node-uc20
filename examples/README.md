# Example Flows for node-red-contrib-uos-nats

This directory contains ready-to-import example flows demonstrating the use of u-OS Data Hub nodes.

## How to Import

1. Open Node-RED
2. Click the menu (☰) → **Import**
3. Click **"select a file to import"**
4. Choose one of the `.json` files from this directory
5. Click **Import**

## Available Examples

###  1. `basic-read-write.json`

**basic-read-write.json** - Basic example showing:
- Reading variables from an existing provider (`u_os_adm`)
- Writing values to a provider variable
- Debug nodes to see the data flow

**What you'll learn:**
- How to configure the u-OS Config node
- How to use the DataHub - Read node
- How to use the DataHub - Write node

---

### 2. `advanced-provider.json`

**Advanced Provider Example** - Shows how to:
- Create your own Data Hub provider
- Auto-generate random data every 5 seconds
- Publish variables with nested structure

**What you'll learn:**
- How to use the DataHub - Provider node
- How to structure data for publishing
- How other apps can subscribe to your data in real-time

**Check your provider:**
After deploying, go to:
```
u-OS Web UI → Data Hub → Providers → "nodered"
```
You'll see all your published variables!

---

## Configuration

Both examples use a placeholder config node. **You must update:**

1. **Host:** IP address of your u-OS device (e.g., `192.168.10.100`)
2. **Client ID & Secret:** Get from u-OS Control Center → Identity & access → Clients
3. **Provider IDs:** Change to match your system's providers
4. **Variable IDs/Keys:** Update to match your variables

---

## Need Help?

Check the main [README.md](../README.md) for detailed documentation on each node.
