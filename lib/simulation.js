export class SimulationEngine {
    constructor(definitions) {
        this.definitions = definitions;
        this.tick = 0;
        this.states = new Map(definitions.map((def) => [def.id, {
                id: def.id,
                value: this.initialValue(def),
                timestampNs: Date.now() * 1000000,
                quality: 'GOOD',
            }]));
    }
    initialValue(def) {
        switch (def.dataType) {
            case 'INT64':
                return 0;
            case 'FLOAT64':
                return 0;
            case 'BOOLEAN':
                return false;
            case 'STRING':
            default:
                return def.key.includes('status') ? 'ready' : '';
        }
    }
    advance() {
        this.tick += 1;
        const nowNs = Date.now() * 1000000;
        for (const def of this.definitions) {
            const state = this.states.get(def.id);
            state.timestampNs = nowNs;
            switch (def.dataType) {
                case 'INT64':
                    state.value = Number(state.value) + 1;
                    break;
                case 'FLOAT64':
                    state.value = Number((20 + Math.sin(this.tick / 5) * 5).toFixed(3));
                    break;
                case 'STRING':
                    if (def.key.includes('status')) {
                        const values = ['ready', 'running', 'idle'];
                        state.value = values[this.tick % values.length];
                    }
                    break;
                case 'BOOLEAN':
                    state.value = !Boolean(state.value);
                    break;
            }
        }
        return Array.from(this.states.values());
    }
    snapshot() {
        return Array.from(this.states.values());
    }
}
