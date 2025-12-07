const flatbuffers = require('flatbuffers');
const builder = new flatbuffers.Builder(1024);
console.log('Type of createObjectOffset:', typeof builder.createObjectOffset);
