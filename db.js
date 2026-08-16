// Simple JSON-file backed user store. No native deps (safe for any build environment).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [] }, null, 2));
  }
}

function readDb() {
  ensureDb();
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { users: [] };
  }
}

function writeDb(db) {
  ensureDb();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function findByUsername(username) {
  const db = readDb();
  const uname = String(username || '').toLowerCase();
  return db.users.find((u) => u.username.toLowerCase() === uname) || null;
}

function findById(id) {
  const db = readDb();
  return db.users.find((u) => u.id === id) || null;
}

function createUser({ username, passwordHash, isAdmin }) {
  const db = readDb();
  const user = {
    id: crypto.randomBytes(9).toString('hex'),
    username,
    passwordHash,
    isAdmin: !!isAdmin,
    coins: isAdmin ? 999999 : 500,
    skin: isAdmin ? 'admin' : 'default',
    ownedSkins: ['default'],
    kills: 0,
    wins: 0,
    createdAt: Date.now(),
  };
  db.users.push(user);
  writeDb(db);
  return user;
}

function saveUser(updated) {
  const db = readDb();
  const idx = db.users.findIndex((u) => u.id === updated.id);
  if (idx === -1) return;
  db.users[idx] = updated;
  writeDb(db);
}

function updateUser(id, patch) {
  const db = readDb();
  const idx = db.users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  db.users[idx] = Object.assign({}, db.users[idx], patch);
  writeDb(db);
  return db.users[idx];
}

function incrementUser(id, fields) {
  const db = readDb();
  const idx = db.users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  Object.keys(fields).forEach((k) => {
    db.users[idx][k] = (db.users[idx][k] || 0) + fields[k];
  });
  writeDb(db);
  return db.users[idx];
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    isAdmin: !!u.isAdmin,
    coins: u.coins,
    skin: u.skin,
    ownedSkins: u.ownedSkins || ['default'],
    kills: u.kills || 0,
    wins: u.wins || 0,
  };
}

module.exports = {
  ensureDb,
  findByUsername,
  findById,
  createUser,
  saveUser,
  updateUser,
  incrementUser,
  publicUser,
};
