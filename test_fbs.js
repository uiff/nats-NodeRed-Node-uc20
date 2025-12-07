const flatbuffers = require('flatbuffers');
// Manually mock the generated classes structure to test the pack logic OR require them if I can (ESM issue?)
// Since files are ESM (.js with export), I cannot require them easily in a simple script without setup.
// I'll try to use a dynamic import in an async IIFE.

(async () => {
    try {
        const { VariableT } = await import('./lib/fbs/weidmueller/ucontrol/hub/variable.js');
        const { VariableValueFloat64T } = await import('./lib/fbs/weidmueller/ucontrol/hub/variable-value-float64.js');
        const { VariableValue } = await import('./lib/fbs/weidmueller/ucontrol/hub/variable-value.js');

        console.log("Classes loaded.");

        const builder = new flatbuffers.Builder(1024);

        const floatVal = new VariableValueFloat64T();
        floatVal.value = 45.2;

        const varT = new VariableT();
        varT.id = 1;
        varT.valueType = VariableValue.Float64;
        varT.value = floatVal;

        console.log("Packing...");
        try {
            const offset = varT.pack(builder);
            console.log("Packed successfully. Offset:", offset);
            builder.finish(offset);
        } catch (e) {
            console.error("Pack failed:", e);
            if (e.stack) console.error(e.stack);
        }

    } catch (err) {
        console.error("Import failed:", err);
    }
})();
