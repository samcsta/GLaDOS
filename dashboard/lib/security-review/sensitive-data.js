const crypto = require('node:crypto');

const SECRET_KEY = /(?:password|passwd|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|private[_-]?key)/i;
const REFERENCE_VALUE = /(?:process\.env|System\.getenv|\$\{|secretmanager|secret[_-]?manager|valueFrom|secretKeyRef|os\.environ|getenv\()/i;
const PLACEHOLDER_VALUE = /^(?:changeme|example|placeholder|dummy|test|your[_-]|<[^>]+>|\*+|x+)$/i;
const PII_RULES = [
  { id: 'email-address', dataClass: 'EMAIL_ADDRESS', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { id: 'phone-number', dataClass: 'PHONE_NUMBER', regex: /(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g },
  { id: 'payment-card', dataClass: 'PAYMENT_CARD', regex: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g },
];

function fingerprint(value, key) {
  return `hmac-sha256-v1:${crypto.createHmac('sha256', key).update(String(value)).digest('hex')}`;
}

function candidateKey(kind, file, line, rule) {
  return `HEAD:${kind}:${file}:${line}:${rule}`;
}

function secretCandidates(file, lines, hmacKey) {
  const rows = [];
  lines.forEach((line, index) => {
    if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(line)) {
      rows.push({ inventory_key: candidateKey('SECRET', file, index + 1, 'private-key'), kind: 'SECRET', data_class: 'PRIVATE_KEY', presence_status: 'CONFIRMED_LITERAL', validation_status: 'UNVERIFIED', fingerprint: fingerprint(line.trim(), hmacKey), value_redacted: true, exposure: 'HEAD', file, line: index + 1, rule: 'private-key' });
      return;
    }
    const assignment = line.match(/([A-Za-z0-9_.-]*(?:password|passwd|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token)[A-Za-z0-9_.-]*)\s*[:=]\s*(?:["']([^"']+)["']|([^\s#]+))/i);
    if (!assignment || !SECRET_KEY.test(assignment[1])) return;
    const value = assignment[2] || assignment[3] || '';
    const reference = REFERENCE_VALUE.test(value);
    const placeholder = PLACEHOLDER_VALUE.test(value);
    rows.push({
      inventory_key: candidateKey('SECRET', file, index + 1, 'secret-assignment'),
      kind: 'SECRET',
      data_class: 'CREDENTIAL',
      presence_status: reference ? 'REFERENCE_ONLY' : placeholder ? 'PATTERN_ONLY' : 'CONFIRMED_LITERAL',
      validation_status: 'UNVERIFIED',
      fingerprint: reference ? null : fingerprint(value, hmacKey),
      value_redacted: true,
      exposure: 'HEAD', file, line: index + 1, rule: 'secret-assignment',
    });
  });
  return rows;
}

function luhn(value) {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index]);
    if (alternate && (digit *= 2) > 9) digit -= 9;
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function piiCandidates(file, lines, hmacKey) {
  const rows = [];
  lines.forEach((line, index) => {
    for (const rule of PII_RULES) {
      rule.regex.lastIndex = 0;
      for (const match of line.matchAll(rule.regex)) {
        const value = match[0];
        if (rule.id === 'payment-card' && !luhn(value)) continue;
        const synthetic = /(?:example\.(?:com|org|net)|test|dummy|sample)/i.test(value);
        rows.push({
          inventory_key: candidateKey('PII', file, index + 1, rule.id), kind: 'PII', data_class: rule.dataClass,
          presence_status: synthetic ? 'PATTERN_ONLY' : 'CONFIRMED_LITERAL', validation_status: 'UNVERIFIED',
          fingerprint: fingerprint(value, hmacKey), value_redacted: true, exposure: 'HEAD', file, line: index + 1, rule: rule.id,
        });
      }
    }
  });
  return rows;
}

function scanSensitiveData(repositoryPath, files, hmacKey) {
  const secrets = [];
  const pii = [];
  for (const relative of files) {
    let text;
    try { text = require('node:fs').readFileSync(require('node:path').join(repositoryPath, relative), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    const lines = text.split(/\r?\n/);
    secrets.push(...secretCandidates(relative, lines, hmacKey));
    pii.push(...piiCandidates(relative, lines, hmacKey));
  }
  return { secrets, pii };
}

function sensitiveDataDispositionBootstrap(candidate) {
  return {
    inventory_key: candidate.inventory_key,
    kind: candidate.kind,
    data_class: candidate.data_class,
    presence_status: candidate.presence_status,
    validation_status: candidate.validation_status || 'UNVERIFIED',
    fingerprint: candidate.fingerprint,
    value_redacted: true,
    exposure: candidate.exposure,
    file: candidate.file,
    line: candidate.line,
    rule: candidate.rule,
    rationale: 'Controller-projected redacted scanner candidate; authenticity remains unverified pending evidence-backed specialist disposition.',
  };
}

function sensitiveDataDispositionRows(candidates) {
  return [...new Map(candidates.map(candidate => [candidate.inventory_key, candidate])).values()]
    .map(sensitiveDataDispositionBootstrap);
}

module.exports = { fingerprint, piiCandidates, scanSensitiveData, secretCandidates, sensitiveDataDispositionBootstrap, sensitiveDataDispositionRows };
