// src/db/index.js
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const adapter = new FileSync(path.join(__dirname, '../../data/db.json'));
const db = low(adapter);

// Set default values
db.defaults({ queue: [], sent: [] }).write();

module.exports = db; 