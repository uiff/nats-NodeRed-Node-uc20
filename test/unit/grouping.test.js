const { expect } = require('chai');

// Simulating the Grouping Logic
const groupVariables = (vars) => {
    const groups = {};
    vars.forEach(v => {
        const parts = v.key.split('.');
        const prefix = parts.length > 1 ? parts[0] : 'Other'; // Simple top-level grouping
        if (!groups[prefix]) groups[prefix] = [];
        groups[prefix].push(v);
    });
    return groups;
};

describe('Variable Grouping Logic', () => {
    const sampleVars = [
        { key: 'system.cpu.load', id: 1 },
        { key: 'system.mem.free', id: 2 },
        { key: 'network.eth0.ip', id: 3 },
        { key: 'uptime', id: 4 }
    ];

    it('should group variables by their top-level prefix', () => {
        const grouped = groupVariables(sampleVars);

        expect(grouped).to.have.property('system');
        expect(grouped).to.have.property('network');
        expect(grouped).to.have.property('Other');

        expect(grouped['system']).to.have.lengthOf(2);
        expect(grouped['network']).to.have.lengthOf(1);
        expect(grouped['Other']).to.have.lengthOf(1);
    });

    it('should place variables without dots into "Other"', () => {
        const grouped = groupVariables([{ key: 'simple_var', id: 1 }]);
        expect(grouped['Other']).to.have.lengthOf(1);
        expect(grouped['Other'][0].key).to.equal('simple_var');
    });
});
