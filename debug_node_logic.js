
const inferType = (value) => {
    if (typeof value === 'boolean') return 'BOOLEAN';
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'INT64' : 'FLOAT64';
    }
    return 'STRING';
};

const defaultValue = (type) => {
    switch (type) {
        case 'BOOLEAN': return false;
        case 'INT64':
        case 'FLOAT64': return 0;
        case 'STRING':
        default: return '';
    }
};

const flattenPayload = (value, prefix = '') => {
    const entries = [];
    const path = (key) => (prefix ? `${prefix}.${key}` : key);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        Object.entries(value).forEach(([key, val]) => {
            if (val !== undefined) {
                entries.push(...flattenPayload(val, path(key)));
            }
        });
    }
    else if (Array.isArray(value)) {
        value.forEach((val, idx) => {
            if (val !== undefined) {
                entries.push(...flattenPayload(val, prefix ? `${prefix}[${idx}]` : `[${idx}]`));
            }
        });
    }
    else {
        const keyName = prefix || 'value';
        entries.push({ key: keyName, value });
    }
    return entries;
};

// Simulation of the node logic
const definitions = [];
const defMap = new Map();
const stateMap = new Map();
let nextId = 0;

const ensureDefinition = (key, dataType) => {
    const normalized = key.trim();
    if (defMap.has(normalized)) {
        return { def: defMap.get(normalized), created: false };
    }
    const def = {
        id: nextId += 1,
        key: normalized,
        dataType,
        access: 'READ_WRITE',
    };
    defMap.set(normalized, def);
    definitions.push(def);
    stateMap.set(def.id, {
        id: def.id,
        value: defaultValue(dataType),
        timestampNs: Date.now() * 1_000_000,
        quality: 'GOOD',
    });
    return { def, created: true };
};

function processPayload(payload) {
    const entries = flattenPayload(payload);
    console.log("Flattened Entries:", JSON.stringify(entries, null, 2));

    let definitionsChanged = false;
    entries.forEach(({ key, value }) => {
        if (value === undefined || value === null) return;
        const { def, created } = ensureDefinition(key, inferType(value));
        if (created) definitionsChanged = true;
    });

    console.log("Definitions Changed:", definitionsChanged);
    console.log("Current Definitions:", JSON.stringify(definitions, null, 2));
}

// TEST CASES
const test1 = { "machine": { "status": "running", "details": { "temp": 45.5 } } };
console.log("\n--- TEST 1: Nested JSON ---");
processPayload(test1);

const test2 = { "machine": { "status": "stopped", "details": { "temp": 20 } } };
console.log("\n--- TEST 2: Update Values (No Def Change) ---");
processPayload(test2);
