const { expect } = require('chai');

// Simulating the Chunking Logic from datahub-input.js
// Ideally, we would export the function from the node, 
// but since it's wrapped in a Node-RED closure, we test the logic behavior here.

const chunkArray = (array, size) => {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
};

describe('Chunking Logic', () => {
    it('should split an array of 250 items into 3 chunks (100, 100, 50)', () => {
        const data = Array.from({ length: 250 }, (_, i) => i);
        const chunks = chunkArray(data, 100);

        expect(chunks).to.have.lengthOf(3);
        expect(chunks[0]).to.have.lengthOf(100);
        expect(chunks[1]).to.have.lengthOf(100);
        expect(chunks[2]).to.have.lengthOf(50);
    });

    it('should handle small arrays correctly (no chunking needed)', () => {
        const data = [1, 2, 3];
        const chunks = chunkArray(data, 100);
        expect(chunks).to.have.lengthOf(1);
        expect(chunks[0]).to.have.lengthOf(3);
    });

    it('should handle exactly 100 items as one chunk', () => {
        const data = Array.from({ length: 100 }, (_, i) => i);
        const chunks = chunkArray(data, 100);
        expect(chunks).to.have.lengthOf(1);
    });

    it('should return empty array for empty input', () => {
        const chunks = chunkArray([], 100);
        expect(chunks).to.have.lengthOf(0);
    });
});
