import * as flatbuffers from 'flatbuffers';
import { VariableList, VariableListT } from './lib/fbs/weidmueller/ucontrol/hub/variable-list.js';
import { TimestampT } from './lib/fbs/weidmueller/ucontrol/hub/timestamp.js';
import { VariableT } from './lib/fbs/weidmueller/ucontrol/hub/variable.js';
import { VariableValueStringT } from './lib/fbs/weidmueller/ucontrol/hub/variable-value-string.js';
import { VariableValue } from './lib/fbs/weidmueller/ucontrol/hub/variable-value.js';

// Mock minimal data
const vars = [
    new VariableT(
        VariableValue.String, // valueType
        new VariableValueStringT('test-val'), // value
        100 // id (Int32)
    )
];

// Timestamp
const ts = new TimestampT(BigInt(1620000000), 0);

// List with timestamp
const varList = new VariableListT(BigInt(123456), ts, vars);

try {
    const builder = new flatbuffers.Builder(1024);

    console.log("Packing VariableListT...");
    // Manually reproduce pack logic to debug
    // varList.pack(builder);

    // Step-by-step reproduction of the failing logic (from 0.2.28 fix attempt)
    const itemsOffset = VariableList.createItemsVector(builder, builder.createObjectOffsetList(varList.items));
    console.log(`Items Vector Offset: ${itemsOffset}, Builder Offset: ${builder.offset()}`);

    const tsOffset = varList.baseTimestamp.pack(builder);
    console.log(`Timestamp Struct Offset: ${tsOffset}, Builder Offset: ${builder.offset()}`);

    VariableList.startVariableList(builder);
    console.log(`Started VariableList (Table). Builder Offset: ${builder.offset()}`);

    // Attempting addBaseTimestamp FIRST
    console.log("Attempting addBaseTimestamp...");
    VariableList.addBaseTimestamp(builder, tsOffset);
    console.log("addBaseTimestamp success!");

    VariableList.addProviderDefinitionFingerprint(builder, varList.providerDefinitionFingerprint);

    VariableList.addItems(builder, itemsOffset);
    const endOffset = VariableList.endVariableList(builder);
    console.log(`Finished VariableList. Offset: ${endOffset}`);

    builder.finish(endOffset);
    console.log("Builder finished successfully.");

} catch (e) {
    console.error("PACKING FAILED:", e);
    // console.error(e.stack);
}
