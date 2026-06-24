// Server-side persistence (SQLite via the built-in node:sqlite module — no native dep).
// Stores: settings (LLM key/endpoint), meetings (info + latest snapshot + digest),
// and audio (the wav chunks that came through /api/asr). On Fly this lives on a mounted
// volume (MINDCANVAS_DB=/data/mindcanvas.db) so it survives restarts/redeploys.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

let db = null;

export function initDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS meetings (
      room TEXT PRIMARY KEY,
      title TEXT,
      status TEXT DEFAULT 'active',
      created_at INTEGER, started_at INTEGER, ended_at INTEGER, updated_at INTEGER,
      stats TEXT, snapshot TEXT, digest_md TEXT
    );
    CREATE TABLE IF NOT EXISTS audio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT, seq INTEGER, t INTEGER, mime TEXT, bytes BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_audio_room ON audio(room);
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY, pass TEXT, role TEXT, created_at INTEGER
    );
  `);
  return db;
}

// ---- users (auth) ----
export function listUsers() {
  return db.prepare('SELECT username, role, created_at FROM users ORDER BY role, username').all();
}
export function getUser(username) {
  return db.prepare('SELECT * FROM users WHERE username=?').get(username);
}
export function upsertUser(username, pass, role) {
  db.prepare('INSERT INTO users(username,pass,role,created_at) VALUES(?,?,?,?) ON CONFLICT(username) DO UPDATE SET pass=excluded.pass, role=excluded.role')
    .run(username, pass, role, Date.now());
}
export function setUserPassword(username, pass) {
  db.prepare('UPDATE users SET pass=? WHERE username=?').run(pass, username);
}
export function deleteUser(username) {
  db.prepare('DELETE FROM users WHERE username=?').run(username);
}
export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}
export function countAdmins() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
}

// ---- settings (key/value) ----
export function getSetting(k) {
  const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k);
  return r ? r.v : null;
}
export function setSetting(k, v) {
  db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v == null ? null : String(v));
}

// ---- meetings ----
export function upsertMeeting(m) {
  const now = Date.now();
  const ex = db.prepare('SELECT room FROM meetings WHERE room=?').get(m.room);
  if (ex) {
    db.prepare('UPDATE meetings SET title=?, stats=?, snapshot=?, digest_md=?, updated_at=?, started_at=COALESCE(started_at,?) WHERE room=?')
      .run(m.title ?? null, m.stats ?? null, m.snapshot ?? null, m.digest_md ?? null, now, m.started_at ?? now, m.room);
  } else {
    db.prepare('INSERT INTO meetings(room,title,status,created_at,started_at,updated_at,stats,snapshot,digest_md) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(m.room, m.title ?? null, m.status ?? 'active', now, m.started_at ?? now, now, m.stats ?? null, m.snapshot ?? null, m.digest_md ?? null);
  }
}
export function endMeeting(room) {
  const now = Date.now();
  db.prepare("UPDATE meetings SET status='ended', ended_at=?, updated_at=? WHERE room=?").run(now, now, room);
}
export function reopenMeeting(room) {
  db.prepare("UPDATE meetings SET status='active', ended_at=NULL, updated_at=? WHERE room=?").run(Date.now(), room);
}
export function getMeeting(room) {
  return db.prepare('SELECT * FROM meetings WHERE room=?').get(room);
}
export function meetingStatus(room) {
  const r = db.prepare('SELECT status FROM meetings WHERE room=?').get(room);
  return r ? r.status : null;
}
export function listMeetings() {
  return db.prepare('SELECT room,title,status,created_at,started_at,ended_at,updated_at,stats FROM meetings ORDER BY updated_at DESC').all();
}
export function deleteMeeting(room) {
  db.prepare('DELETE FROM meetings WHERE room=?').run(room);
  db.prepare('DELETE FROM audio WHERE room=?').run(room);
}

// ---- audio ----
export function addAudio(room, seq, mime, bytes) {
  db.prepare('INSERT INTO audio(room,seq,t,mime,bytes) VALUES(?,?,?,?,?)').run(room, seq, Date.now(), mime, bytes);
}
export function audioInfo(room) {
  return db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(bytes)),0) AS bytes FROM audio WHERE room=?').get(room);
}
export function getAudioChunk(room, seq) {
  return db.prepare('SELECT mime, bytes FROM audio WHERE room=? AND seq=?').get(room, seq);
}
