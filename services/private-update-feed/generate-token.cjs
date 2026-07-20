#!/usr/bin/env node
const crypto = require('node:crypto');
const token = `glados_upd_${crypto.randomBytes(32).toString('base64url')}`;
const hash = crypto.createHash('sha256').update(token).digest('hex');
process.stdout.write(`token=${token}\nsha256=${hash}\n`);
