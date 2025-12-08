import { createHash } from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import { ProviderDefinitionChangedEventT } from './fbs/weidmueller/ucontrol/hub/provider-definition-changed-event.js';
import { ProviderDefinitionT } from './fbs/weidmueller/ucontrol/hub/provider-definition.js';
import { VariableDefinitionT } from './fbs/weidmueller/ucontrol/hub/variable-definition.js';
import { VariableAccessType } from './fbs/weidmueller/ucontrol/hub/variable-access-type.js';
import { VariableDataType } from './fbs/weidmueller/ucontrol/hub/variable-data-type.js';
import { VariablesChangedEventT } from './fbs/weidmueller/ucontrol/hub/variables-changed-event.js';
import { VariableListT } from './fbs/weidmueller/ucontrol/hub/variable-list.js';
import { VariableT } from './fbs/weidmueller/ucontrol/hub/variable.js';
import { VariableQuality } from './fbs/weidmueller/ucontrol/hub/variable-quality.js';
import { VariableValue } from './fbs/weidmueller/ucontrol/hub/variable-value.js';
import { VariableValueInt64, VariableValueInt64T } from './fbs/weidmueller/ucontrol/hub/variable-value-int64.js';
import { VariableValueFloat64, VariableValueFloat64T } from './fbs/weidmueller/ucontrol/hub/variable-value-float64.js';
import { VariableValueString, VariableValueStringT } from './fbs/weidmueller/ucontrol/hub/variable-value-string.js';
import { VariableValueBoolean, VariableValueBooleanT } from './fbs/weidmueller/ucontrol/hub/variable-value-boolean.js';
import { TimestampT } from './fbs/weidmueller/ucontrol/hub/timestamp.js';
import { ReadVariablesQueryResponseT } from './fbs/weidmueller/ucontrol/hub/read-variables-query-response.js';
import { ReadVariablesQueryRequestT } from './fbs/weidmueller/ucontrol/hub/read-variables-query-request.js';
import { ReadVariablesQueryRequest } from './fbs/weidmueller/ucontrol/hub/read-variables-query-request.js';
import { ReadProviderDefinitionQueryRequest } from './fbs/weidmueller/ucontrol/hub/read-provider-definition-query-request.js';
import { WriteVariablesCommandT } from './fbs/weidmueller/ucontrol/hub/write-variables-command.js';
import { StateChangedEvent } from './fbs/weidmueller/ucontrol/hub/state-changed-event.js';
import { State } from './fbs/weidmueller/ucontrol/hub/state.js';

const DEFAULT_QUALITY = 'GOOD';
export function buildProviderDefinitionEvent(defs) {
    const fingerprint = computeFingerprint(defs);
    const providerDefinition = new ProviderDefinitionT();
    providerDefinition.fingerprint = fingerprint;
    providerDefinition.variableDefinitions = defs.map(toFlatDefinition);
    const event = new ProviderDefinitionChangedEventT(providerDefinition);
    const builder = new flatbuffers.Builder(1024);
    const offset = event.pack(builder);
    builder.finish(offset);
    return { payload: builder.asUint8Array(), fingerprint };
}
export function buildVariablesChangedEvent(defs, states, fingerprint) {
    const varList = buildVariableList(defs, states, fingerprint);
    const event = new VariablesChangedEventT(varList);
    const builder = new flatbuffers.Builder(1024);
    builder.finish(event.pack(builder));
    return builder.asUint8Array();
}
export function buildReadVariablesResponse(defs, states, fingerprint) {
    const variables = [];
    for (const def of defs) {
        const state = states[def.id];
        if (!state) continue;
        variables.push(encodeVariableState(def, state));
    }

    // Calculate baseTimestamp from the first available state, if any
    // Calculate baseTimestamp from the first available state, if any, or use now
    let baseTimestamp = null;
    const firstState = Object.values(states)[0];
    if (firstState && firstState.timestamp) {
        const totalNs = BigInt(firstState.timestamp);
        const secs = totalNs / 1_000_000_000n;
        const nanos = Number(totalNs % 1_000_000_000n);
        baseTimestamp = new TimestampT(secs, nanos);
    } else {
        baseTimestamp = nowNs();
    }

    const varList = new VariableListT(fingerprint, baseTimestamp, variables);

    const response = new ReadVariablesQueryResponseT();
    response.variables = varList;

    const builder = new flatbuffers.Builder(1024);
    const offset = response.pack(builder);
    builder.finish(offset);
    return builder.asUint8Array();
}
// Helper to omit field if null/empty

export function buildReadVariablesQuery(ids) {
    const builder = new flatbuffers.Builder(128);
    let idsOffset = 0;

    if (ids && ids.length > 0) {
        idsOffset = ReadVariablesQueryRequest.createIdsVector(builder, ids);
    }

    ReadVariablesQueryRequest.startReadVariablesQueryRequest(builder);
    if (idsOffset > 0) {
        ReadVariablesQueryRequest.addIds(builder, idsOffset);
    }
    const offset = ReadVariablesQueryRequest.endReadVariablesQueryRequest(builder);

    builder.finish(offset);
    return builder.asUint8Array();
}
// Helper to build definition query

export function buildReadProviderDefinitionQuery() {
    const builder = new flatbuffers.Builder(32);
    ReadProviderDefinitionQueryRequest.startReadProviderDefinitionQueryRequest(builder);
    const offset = ReadProviderDefinitionQueryRequest.endReadProviderDefinitionQueryRequest(builder);
    builder.finish(offset);
    return builder.asUint8Array();
}

export function parseRegistryStateEvent(buffer) {
    const bb = new flatbuffers.ByteBuffer(buffer);
    const event = StateChangedEvent.getRootAsStateChangedEvent(bb);
    // State is an enum: 1 = RUNNING
    return event.state();
}

// Encode write variables command
export function encodeWriteVariablesCommand(variables) {
    // variables: [{id: number, value: any}, ...]
    // variables: [{id: number, value: any}, ...]
    // VariableListT constructor: fingerprint, baseTimestamp, items
    // VariableListT constructor: fingerprint, baseTimestamp, items
    const varList = new VariableListT(BigInt(0), nowNs(), []);
    varList.items = variables.map(v => {
        const varT = new VariableT();
        varT.id = v.id;
        varT.quality = VariableQuality.GOOD;
        varT.timestamp = nowNs();

        // Encode value based on type
        // Explicitly handle null/undefined by defaulting to safe empty values based on type
        const val = v.value;
        let targetType = v.dataType; // Optional known type from definition

        // If targetType is provided, force specific flatbuffer encoding
        if (targetType) {
            targetType = String(targetType).toUpperCase();
            if (targetType === 'BOOLEAN') {
                const boolVal = new VariableValueBooleanT();
                boolVal.value = Boolean(val);
                varT.value = boolVal;
                varT.valueType = VariableValue.Boolean;
            } else if (targetType === 'INT64') {
                const intVal = new VariableValueInt64T();
                intVal.value = BigInt(parseInt(val) || 0); // Ensure BigInt
                varT.value = intVal;
                varT.valueType = VariableValue.Int64;
            } else if (targetType === 'FLOAT64') {
                const floatVal = new VariableValueFloat64T();
                floatVal.value = Number(val);
                varT.value = floatVal;
                varT.valueType = VariableValue.Float64;
            } else {
                // STRING or default
                const strVal = new VariableValueStringT();
                strVal.value = (typeof val === 'object') ? JSON.stringify(val) : String(val);
                varT.value = strVal;
                varT.valueType = VariableValue.String;
            }
        }
        // Fallback: Infer from value (Risk: Int sent as Float or vice versa)
        else if (typeof val === 'boolean') {
            const boolVal = new VariableValueBooleanT();
            boolVal.value = val;
            varT.value = boolVal;
            varT.valueType = VariableValue.Boolean;
        } else if (Number.isInteger(val)) {

            const intVal = new VariableValueInt64T();
            intVal.value = BigInt(val);
            varT.value = intVal;
            varT.valueType = VariableValue.Int64;
        } else if (typeof val === 'number') {
            const floatVal = new VariableValueFloat64T();
            floatVal.value = val;
            varT.value = floatVal;
            varT.valueType = VariableValue.Float64;
        } else if (typeof val === 'string') {
            const strVal = new VariableValueStringT();
            strVal.value = val;
            varT.value = strVal;
            varT.valueType = VariableValue.String;
        } else {
            // Fallback for objects/arrays: try stringify?
            // Or just fail? The user reported "Unsupported value type: object" before.
            // If it is an object (unexpected), we should probably fail or stringify.
            try {
                const strVal = new VariableValueStringT();
                strVal.value = JSON.stringify(val);
                varT.value = strVal;
                varT.valueType = VariableValue.String;
            } catch (e) {
                throw new Error(`Unsupported value type: ${typeof val}`);
            }
        }

        return varT;
    });

    const cmd = new WriteVariablesCommandT(varList);
    const builder = new flatbuffers.Builder(512);
    builder.finish(cmd.pack(builder));
    return builder.asUint8Array();
}

export function decodeVariableList(list) {
    if (!list)
        return [];
    const result = [];
    for (let i = 0; i < list.itemsLength(); i += 1) {
        const item = list.items(i);
        if (!item)
            continue;
        let decoded;
        switch (item.valueType()) {
            case VariableValue.Int64: {
                const holder = new VariableValueInt64();
                item.value(holder);
                decoded = Number(holder.value());
                break;
            }
            case VariableValue.Float64: {
                const holder = new VariableValueFloat64();
                item.value(holder);
                decoded = holder.value();
                break;
            }
            case VariableValue.Boolean: {
                const holder = new VariableValueBoolean();
                item.value(holder);
                decoded = holder.value();
                break;
            }
            case VariableValue.String: {
                const holder = new VariableValueString();
                item.value(holder);
                decoded = holder.value();
                break;
            }
            default:
                decoded = null;
        }
        const quality = decodeQuality(item.quality());
        const timestampNs = decodeTimestamp(item.timestamp());
        result.push({
            id: item.id(),
            value: decoded,
            quality,
            timestampNs,
        });
    }
    return result;
}
import { ProviderList } from './fbs/weidmueller/ucontrol/hub/provider-list.js';
import { ReadProvidersQueryResponse } from './fbs/weidmueller/ucontrol/hub/read-providers-query-response.js';
import { ReadProviderDefinitionQueryResponse } from './fbs/weidmueller/ucontrol/hub/read-provider-definition-query-response.js';
import { VariableList } from './fbs/weidmueller/ucontrol/hub/variable-list.js';
export function decodeProviderList(bb) {
    const response = ReadProvidersQueryResponse.getRootAsReadProvidersQueryResponse(bb);
    const list = response.providers();
    if (!list)
        return [];
    const result = [];
    for (let i = 0; i < list.itemsLength(); i += 1) {
        const prov = list.items(i);
        if (!prov)
            continue;
        result.push({ id: prov.id() || '' });
    }
    return result;
}
export function decodeProviderDefinition(bb) {
    const response = ReadProviderDefinitionQueryResponse.getRootAsReadProviderDefinitionQueryResponse(bb);
    const def = response.providerDefinition();
    if (!def)
        return null;
    const variableDefs = [];
    for (let i = 0; i < def.variableDefinitionsLength(); i += 1) {
        const varDef = def.variableDefinitions(i);
        if (!varDef)
            continue;
        variableDefs.push({
            id: varDef.id(),
            key: varDef.key() || '',
            dataType: decodeDataType(varDef.dataType()),
            access: decodeAccessType(varDef.accessType()),
        });
    }
    return {
        fingerprint: def.fingerprint(),
        variables: variableDefs,
    };
}
// Helper to build VariableListT

function buildVariableList(defs, states, fingerprint) {
    const variables = [];
    for (const def of defs) {
        const state = states[def.id];
        // Reference implementation (Python) ignores variables without state
        if (!state) continue;
        variables.push(encodeVariableState(def, state));
    }
    // Always provide a baseTimestamp to satisfy strict schema requirements
    // Use the timestamp of the first item if available, otherwise NOW.
    // This allows relative timestamps in the list to be non-negative if we tracked deltas,
    // but mostly ensures logical consistency (Base <= Item).
    let baseTimestamp = null;
    if (variables.length > 0 && variables[0].timestamp) {
        baseTimestamp = variables[0].timestamp;
    } else {
        baseTimestamp = nowNs();
    }

    const list = new VariableListT(fingerprint, baseTimestamp, variables);
    return list;
}
function encodeVariableState(def, state) {
    const varT = new VariableT();
    varT.id = def.id;
    varT.quality = VariableQuality[state?.quality?.toUpperCase?.()] ?? VariableQuality[DEFAULT_QUALITY];

    // Logic matches Sample: use state.timestamp or now
    if (state?.timestamp) {
        const totalNs = BigInt(state.timestamp);
        const secs = totalNs / 1_000_000_000n;
        const nanos = Number(totalNs % 1_000_000_000n);
        varT.timestamp = new TimestampT(secs, nanos);
    } else {
        varT.timestamp = nowNs();
    }
    // Field 6 (value) MUST be set if valueType is not NONE
    // We default to String empty if value is null/undefined to satisfy schema if needed,
    // or we must ensure valueType is handled correctly.
    // However, for defining variables (initial state), value IS required properly.

    // Explicitly handle null/undefined by defaulting to safe empty values based on type
    const value = state?.value;
    switch (def.dataType) {
        case 'INT64': {
            const intVal = new VariableValueInt64T();
            // Match sample: Use Math.trunc() to be safe if a Float arrives for an Int definition
            intVal.value = (value !== null && value !== undefined) ? BigInt(Math.trunc(Number(value))) : BigInt(0);
            varT.value = intVal;
            varT.valueType = VariableValue.Int64;
            break;
        }
        case 'FLOAT64': {
            const floatVal = new VariableValueFloat64T();
            floatVal.value = (value !== null && value !== undefined) ? Number(value) : 0.0;
            varT.value = floatVal;
            varT.valueType = VariableValue.Float64;
            break;
        }
        case 'BOOLEAN': {
            const boolVal = new VariableValueBooleanT();
            boolVal.value = (value !== null && value !== undefined) ? Boolean(value) : false;
            varT.value = boolVal;
            varT.valueType = VariableValue.Boolean;
            break;
        }
        case 'STRING':
        default: {
            try {
                const strVal = new VariableValueStringT();
                const valStr = (value !== null && value !== undefined) ?
                    (typeof value === 'object' ? JSON.stringify(value) : String(value))
                    : '';
                strVal.value = valStr;
                varT.value = strVal;
                varT.valueType = VariableValue.String;
            } catch (e) {
                // Last resort fallback
                const strVal = new VariableValueStringT();
                strVal.value = "";
                varT.value = strVal;
                varT.valueType = VariableValue.String;
            }
            break;
        }
    }
    return varT;
}
function nowNs() {
    const now = BigInt(Date.now()) * 1_000_000n;
    const secs = now / 1_000_000_000n;
    const nanos = Number(now % 1_000_000_000n);
    return new TimestampT(secs, nanos);
}
function decodeTimestamp(ts) {
    if (!ts) return 0;
    const secs = BigInt(ts.seconds());
    const nanos = BigInt(ts.nanos());
    // Return Number (milliseconds precision mostly, but accurate as ns)
    // Note: Number.MAX_SAFE_INTEGER is 2^53, enough for ns?
    // 2^53 ns is only ~104 days. We simply return Number for compatibility, 
    // but ideally we should keep BigInt. 
    // For Node-RED flows, standard JS Date is ms.
    // Let's return Number(ns) but warn it might lose precision?
    // Actually, converting to Number might be dangerous for full NS timestamp,
    // but the original code returned Number. 
    // Let's stick to returning Number for now to avoid breaking changes, 
    // or return BigInt if the flow expects it? 
    // The Input node stores it as 'timestampNs' in state.

    // Better: Return Number (approx) 
    return Number(secs * 1_000_000_000n + nanos);
}
function decodeDataType(dt) {
    switch (dt) {
        case VariableDataType.INT64:
            return 'INT64';
        case VariableDataType.FLOAT64:
            return 'FLOAT64';
        case VariableDataType.BOOLEAN:
            return 'BOOLEAN';
        case VariableDataType.STRING:
        default:
            return 'STRING';
    }
}
function decodeAccessType(dt) {
    switch (dt) {
        case VariableAccessType.READWRITE:
            return 'READWRITE';
        case VariableAccessType.READONLY:
        default:
            return 'READONLY';
    }
}
function decodeQuality(q) {
    switch (q) {
        case VariableQuality.BAD:
            return 'BAD';
        case VariableQuality.UNCERTAIN:
            return 'UNCERTAIN';
        case VariableQuality.GOOD_LOCAL_OVERRIDE:
            return 'GOOD_LOCAL_OVERRIDE';
        case VariableQuality.GOOD:
        default:
            return 'GOOD';
    }
}
function toFlatDefinition(def) {
    const varDef = new VariableDefinitionT();
    varDef.id = def.id;
    varDef.key = def.key;
    varDef.dataType = mapDataType(def.dataType);
    varDef.accessType = mapAccessType(def.access);
    if (def.experimental !== undefined && def.experimental !== null) {
        varDef.experimental = Boolean(def.experimental);
    }
    return varDef;
}
function mapAccessType(access) {
    switch (access?.toUpperCase?.()) {
        case 'READWRITE':
            return VariableAccessType.READ_WRITE;
        case 'READONLY':
        default:
            return VariableAccessType.READ_ONLY;
    }
}
function mapDataType(dataType) {
    switch (dataType?.toUpperCase?.()) {
        case 'INT64':
            return VariableDataType.INT64;
        case 'FLOAT64':
            return VariableDataType.FLOAT64;
        case 'BOOLEAN':
            return VariableDataType.BOOLEAN;
        case 'STRING':
        default:
            return VariableDataType.STRING;
    }
}
// Map string types to Hash strings (Match nats-node-sample behavior!)
function mapDataTypeToHashString(dt) {
    // Sample hashes the raw config string: 'STRING', 'INT64' etc.
    return String(dt).toUpperCase();
}

// Map access types to Hash strings (Match nats-node-sample behavior!)
function mapAccessTypeToHashString(ac) {
    // Sample hashes 'READ_WRITE' or 'READ_ONLY'
    const normalized = String(ac).toUpperCase();
    if (normalized === 'READWRITE' || normalized === 'READ_WRITE') return 'READ_WRITE';
    return 'READ_ONLY';
}

export function computeFingerprint(defs) {
    const hash = createHash('sha256');
    for (const def of [...defs].sort((a, b) => a.id - b.id)) {
        // Must match nats-node-sample: id:key:type:access:experimental
        // Sample uses: `${def.id}:${def.key}:${def.dataType}:${def.access}:${def.experimental ?? false}`
        // Where dataType is 'STRING', access is 'READ_WRITE' (or READ_ONLY), experimental is 'false' (lowercase)

        const dtStr = mapDataTypeToHashString(def.dataType);
        const acStr = mapAccessTypeToHashString(def.access);
        const exp = def.experimental ?? false;

        // Sample uses template literal boolean conversion: 'false' or 'true' (lowercase)
        const expStr = String(Boolean(exp));

        const preHash = `${def.id}:${def.key}:${dtStr}:${acStr}:${expStr}`;
        console.log(`[DataHub Payloads] Fingerprint part: ${preHash}`);
        hash.update(preHash);
    }
    const digest = hash.digest();
    const fp = digest.readBigUInt64BE(0);
    console.log(`[DataHub Payloads] Computed Fingerprint: ${fp}`);
    return fp;
}
